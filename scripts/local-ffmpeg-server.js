import http from 'http';
import { spawn, execSync } from 'child_process';

// On Windows, npx must be invoked as npx.cmd (spawn doesn't use shell by default)
const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';
import { createWriteStream, createReadStream, unlinkSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import formidable from 'formidable';
import { GoogleGenAI } from '@google/genai';
import { fal } from '@fal-ai/client';

// Load environment variables from .dev.vars
function loadEnvVars() {
  // Check multiple locations for .dev.vars
  const possiblePaths = [
    join(process.cwd(), '.dev.vars'),
    join(process.cwd(), '..', '.dev.vars'),  // Parent directory (when running from scripts/)
    join(import.meta.dirname, '..', '.dev.vars'),  // Relative to this file
  ];

  for (const envPath of possiblePaths) {
    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const [key, ...valueParts] = line.split('=');
          if (key && valueParts.length > 0) {
            process.env[key.trim()] = valueParts.join('=').trim();
          }
        }
        console.log(`Loaded environment from: ${envPath}`);
        return;
      }
    } catch (e) {
      // Try next path
    }
  }
  console.warn('Could not find .dev.vars in any expected location');
}
loadEnvVars();

// Configure fal.ai client - SDK expects FAL_KEY env var or credentials config
// Map FAL_API_KEY to FAL_KEY for backward compatibility
if (process.env.FAL_API_KEY && !process.env.FAL_KEY) {
  process.env.FAL_KEY = process.env.FAL_API_KEY;
}
// Explicitly configure fal.ai with credentials
if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
  console.log('fal.ai configured with API key');
}

const PORT = 3333;
const TEMP_DIR = join(tmpdir(), 'hyperedit-ffmpeg');
const SESSIONS_DIR = join(TEMP_DIR, 'sessions');

// Ensure ffmpeg/ffprobe are on PATH — on Windows they may only be installed via WinGet or similar
// without being added to the system PATH accessible by Node's execSync/spawn.
{
  const ffmpegCandidateDirs = [
    // WinGet full build
    join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Microsoft', 'WinGet', 'Packages',
      'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.0.1-full_build', 'bin'),
    // WinGet essentials build
    join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Microsoft', 'WinGet', 'Packages',
      'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.0.1-essentials_build', 'bin'),
    // openclaw toolchain
    join(process.env.USERPROFILE || 'C:\\Users\\Default', '.openclaw', 'tools', 'ffmpeg',
      'ffmpeg-8.0.1-essentials_build', 'bin'),
    join(process.env.USERPROFILE || 'C:\\Users\\Default', '.openclaw', 'tools', 'ffmpeg',
      'ffmpeg-8.0.1-full_build', 'bin'),
    // Common manual install locations
    'C:\\ffmpeg\\bin',
    join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
  ];
  const pathSep = process.platform === 'win32' ? ';' : ':';
  for (const dir of ffmpegCandidateDirs) {
    if (existsSync(join(dir, 'ffmpeg.exe')) || existsSync(join(dir, 'ffmpeg'))) {
      process.env.PATH = dir + pathSep + (process.env.PATH || '');
      console.log(`[Server] FFmpeg found at: ${dir}`);
      break;
    }
  }
}

// Active video sessions - keeps videos on disk between edits
const sessions = new Map();

// Ensure temp directories exist
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Restore sessions from disk on server start
function restoreSessionsFromDisk() {
  console.log('[Server] Restoring sessions from disk...');
  const sessionDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const sessionId of sessionDirs) {
    const sessionDir = join(SESSIONS_DIR, sessionId);
    const assetsDir = join(sessionDir, 'assets');
    const rendersDir = join(sessionDir, 'renders');

    // Skip if assets directory doesn't exist
    if (!existsSync(assetsDir)) {
      console.log(`[Session] Skipping ${sessionId} - no assets directory`);
      continue;
    }

    // Restore project state from disk if it exists
    const projectPath = join(sessionDir, 'project.json');
    let projectState = {
      tracks: [
        { id: 'T1', type: 'text', name: 'T1', order: 0 },
        { id: 'V3', type: 'video', name: 'V3', order: 1 },
        { id: 'V2', type: 'video', name: 'V2', order: 2 },
        { id: 'V1', type: 'video', name: 'V1', order: 3 },
        { id: 'A1', type: 'audio', name: 'A1', order: 4 },
        { id: 'A2', type: 'audio', name: 'A2', order: 5 },
      ],
      clips: [],
      settings: { width: 1920, height: 1080, fps: 30 },
      captionData: {},
    };

    if (existsSync(projectPath)) {
      try {
        projectState = JSON.parse(readFileSync(projectPath, 'utf-8'));
      } catch (e) {
        console.log(`[Session] Could not read project.json for ${sessionId}`);
      }
    }

    // Restore assets from disk
    const assets = new Map();

    // Try to load saved asset metadata first
    const assetsMetaPath = join(sessionDir, 'assets-meta.json');
    let savedAssetsMeta = {};
    if (existsSync(assetsMetaPath)) {
      try {
        savedAssetsMeta = JSON.parse(readFileSync(assetsMetaPath, 'utf-8'));
        console.log(`[Session] Found saved metadata for ${Object.keys(savedAssetsMeta).length} assets`);
      } catch (e) {
        console.log(`[Session] Could not read assets-meta.json for ${sessionId}`);
      }
    }

    const assetFiles = readdirSync(assetsDir, { withFileTypes: true })
      .filter(dirent => dirent.isFile() && !dirent.name.includes('_thumb'));

    for (const assetFile of assetFiles) {
      const assetPath = join(assetsDir, assetFile.name);
      const assetId = assetFile.name.replace(/\.[^/.]+$/, ''); // Remove extension
      const ext = assetFile.name.split('.').pop().toLowerCase();

      // Determine asset type from extension
      let type = 'video';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        type = 'image';
      } else if (['mp3', 'wav', 'aac', 'm4a'].includes(ext)) {
        type = 'audio';
      }

      try {
        const stats = statSync(assetPath);
        const thumbPath = join(assetsDir, `${assetId}_thumb.jpg`);

        // Merge with saved metadata if available
        const savedMeta = savedAssetsMeta[assetId] || {};

        // Re-detect duration if missing or 0 (can happen if getMediaInfo failed on upload)
        let assetDuration = savedMeta.duration || 0;
        if (!assetDuration && (type === 'video' || type === 'audio')) {
          try {
            const r = execSync(
              `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${assetPath}"`,
              { encoding: 'utf-8' }
            );
            assetDuration = parseFloat(r.trim()) || 0;
            if (assetDuration > 0) {
              console.log(`[Session] Re-detected duration for ${assetFile.name}: ${assetDuration.toFixed(2)}s`);
            }
          } catch {}
        }

        assets.set(assetId, {
          id: assetId,
          type: savedMeta.type || type,
          filename: savedMeta.filename || assetFile.name,
          path: assetPath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          size: stats.size,
          createdAt: savedMeta.createdAt || stats.mtimeMs,
          // Restore AI-generated metadata
          aiGenerated: savedMeta.aiGenerated || false,
          description: savedMeta.description,
          sceneCount: savedMeta.sceneCount,
          sceneDataPath: savedMeta.sceneDataPath,
          editCount: savedMeta.editCount || 0,
          duration: assetDuration,
          width: savedMeta.width,
          height: savedMeta.height,
        });

        if (savedMeta.aiGenerated) {
          console.log(`[Session] Restored AI-generated asset: ${assetFile.name}`);
        }
      } catch (e) {
        console.log(`[Session] Could not stat asset ${assetFile.name}`);
      }
    }

    if (assets.size === 0) {
      console.log(`[Session] Skipping ${sessionId} - no assets found`);
      continue;
    }

    const session = {
      id: sessionId,
      dir: sessionDir,
      assetsDir,
      rendersDir,
      currentVideo: join(sessionDir, 'current.mp4'), // Legacy
      originalName: 'Restored Project',
      createdAt: Date.now(),
      editCount: 0,
      assets,
      project: projectState,
      transcriptCache: new Map(),
    };

    sessions.set(sessionId, session);
    console.log(`[Session] Restored: ${sessionId} (${assets.size} assets)`);
  }

  console.log(`[Server] Restored ${sessions.size} sessions from disk`);
}

// Save asset metadata to disk (preserves aiGenerated flag, etc.)
function saveAssetMetadata(session) {
  if (!session || !session.dir) return;

  const assetsMetaPath = join(session.dir, 'assets-meta.json');
  const metadata = {};

  for (const [assetId, asset] of session.assets) {
    // Only save metadata that needs to persist (not paths which are reconstructed)
    metadata[assetId] = {
      type: asset.type,
      filename: asset.filename,
      createdAt: asset.createdAt,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      // AI-generated specific metadata
      aiGenerated: asset.aiGenerated || false,
      description: asset.description,
      sceneCount: asset.sceneCount,
      sceneDataPath: asset.sceneDataPath,
      editCount: asset.editCount || 0,
    };
  }

  try {
    writeFileSync(assetsMetaPath, JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.log(`[Session] Could not save assets metadata: ${e.message}`);
  }
}

// Run restoration on module load
restoreSessionsFromDisk();

// Session management
function createSession(originalName) {
  const sessionId = randomUUID();
  const sessionDir = join(SESSIONS_DIR, sessionId);
  const assetsDir = join(sessionDir, 'assets');
  const rendersDir = join(sessionDir, 'renders');

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(rendersDir, { recursive: true });

  // Initialize project state with all 6 tracks
  const projectState = {
    tracks: [
      { id: 'T1', type: 'text', name: 'T1', order: 0 },    // Captions/text track (top)
      { id: 'V3', type: 'video', name: 'V3', order: 1 },   // Top overlay (B-roll)
      { id: 'V2', type: 'video', name: 'V2', order: 2 },   // Overlay (GIFs)
      { id: 'V1', type: 'video', name: 'V1', order: 3 },   // Base video track
      { id: 'A1', type: 'audio', name: 'A1', order: 4 },   // Audio track 1
      { id: 'A2', type: 'audio', name: 'A2', order: 5 },   // Audio track 2
    ],
    clips: [],
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
    },
  };

  const session = {
    id: sessionId,
    dir: sessionDir,
    assetsDir,
    rendersDir,
    currentVideo: join(sessionDir, 'current.mp4'), // Legacy support
    originalName,
    createdAt: Date.now(),
    editCount: 0,
    assets: new Map(), // assetId -> asset info
    project: projectState,
    transcriptCache: new Map(), // assetId -> { text, words, cachedAt }
  };
  sessions.set(sessionId, session);
  console.log(`[Session] Created: ${sessionId}`);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      rmSync(session.dir, { recursive: true, force: true });
      sessions.delete(sessionId);
      console.log(`[Session] Cleaned up: ${sessionId}`);
    } catch (e) {
      console.error(`[Session] Cleanup error for ${sessionId}:`, e.message);
    }
  }
}

// Clean up old sessions (older than 2 hours)
setInterval(() => {
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const [id, session] of sessions) {
    if (session.createdAt < twoHoursAgo) {
      console.log(`[Session] Auto-cleaning old session: ${id}`);
      cleanupSession(id);
    }
  }
}, 30 * 60 * 1000); // Check every 30 minutes

// Run FFmpeg command and return a promise
function runFFmpeg(args, jobId) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') || line.includes('frame=')) {
          process.stdout.write(`\r[${jobId}] ${line.trim()}`);
        }
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    ffmpeg.on('error', reject);
  });
}

// Run FFprobe command and return stdout
function runFFmpegProbe(args, jobId) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`FFprobe failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    ffprobe.on('error', reject);
  });
}

// Detect silence in video and return silence periods
async function detectSilence(inputPath, jobId, options = {}) {
  const {
    silenceThreshold = -40, // dB
    minSilenceDuration = 0.5, // seconds
  } = options;

  console.log(`[${jobId}] Detecting silence (threshold: ${silenceThreshold}dB, min duration: ${minSilenceDuration}s)...`);

  const args = [
    '-i', inputPath,
    '-af', `silencedetect=noise=${silenceThreshold}dB:d=${minSilenceDuration}`,
    '-f', 'null',
    '-'
  ];

  const stderr = await runFFmpeg(args, jobId);

  // Parse silence detection output
  const silencePeriods = [];
  const lines = stderr.split('\n');

  let currentStart = null;
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);

    if (startMatch) {
      currentStart = parseFloat(startMatch[1]);
    }
    if (endMatch && currentStart !== null) {
      silencePeriods.push({
        start: currentStart,
        end: parseFloat(endMatch[1])
      });
      currentStart = null;
    }
  }

  console.log(`\n[${jobId}] Found ${silencePeriods.length} silence periods`);
  return silencePeriods;
}

// Get video/audio duration (returns 0 for images)
async function getVideoDuration(inputPath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      { encoding: 'utf-8' }
    );
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

// Calculate segments to keep (inverse of silence periods)
function calculateKeepSegments(silencePeriods, totalDuration, minSegmentDuration = 0.1) {
  if (silencePeriods.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  const keepSegments = [];
  let lastEnd = 0;

  for (const silence of silencePeriods) {
    if (silence.start > lastEnd + minSegmentDuration) {
      keepSegments.push({
        start: lastEnd,
        end: silence.start
      });
    }
    lastEnd = silence.end;
  }

  // Add final segment if there's content after last silence
  if (lastEnd < totalDuration - minSegmentDuration) {
    keepSegments.push({
      start: lastEnd,
      end: totalDuration
    });
  }

  return keepSegments;
}

// Remove dead air from video
async function handleRemoveDeadAir(req, res) {
  const jobId = randomUUID();
  const inputPath = join(TEMP_DIR, `${jobId}-input.mp4`);
  const outputPath = join(TEMP_DIR, `${jobId}-output.mp4`);
  const concatListPath = join(TEMP_DIR, `${jobId}-concat.txt`);
  const segmentPaths = [];

  try {
    // Parse the multipart form
    const form = formidable({
      maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
      uploadDir: TEMP_DIR,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const videoFile = files.video?.[0];
    // More aggressive defaults for "magical" dead air removal
    // -30dB catches more pauses, 0.3s cuts shorter gaps
    const silenceThreshold = parseFloat(fields.silenceThreshold?.[0] || '-30');
    const minSilenceDuration = parseFloat(fields.minSilenceDuration?.[0] || '0.3');

    if (!videoFile) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing video file' }));
      return;
    }

    // Rename uploaded file to our input path
    const { rename, stat } = await import('fs/promises');
    await rename(videoFile.filepath, inputPath);

    console.log(`\n[${jobId}] === DEAD AIR REMOVAL ===`);
    console.log(`[${jobId}] Input file size: ${(videoFile.size / 1024 / 1024).toFixed(1)} MB`);

    // Step 1: Get video duration
    const totalDuration = await getVideoDuration(inputPath);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    // Step 2: Detect silence
    const silencePeriods = await detectSilence(inputPath, jobId, {
      silenceThreshold,
      minSilenceDuration,
    });

    if (silencePeriods.length === 0) {
      console.log(`[${jobId}] No silence detected, returning original video`);
      // Return original video
      const outputStats = await stat(inputPath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': outputStats.size,
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(inputPath).pipe(res);
      return;
    }

    // Step 3: Calculate segments to keep
    const keepSegments = calculateKeepSegments(silencePeriods, totalDuration);
    console.log(`[${jobId}] Keeping ${keepSegments.length} segments:`);
    keepSegments.forEach((seg, i) => {
      console.log(`[${jobId}]   Segment ${i + 1}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s (${(seg.end - seg.start).toFixed(2)}s)`);
    });

    const totalKeptDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const removedDuration = totalDuration - totalKeptDuration;
    console.log(`[${jobId}] Removing ${removedDuration.toFixed(2)}s of dead air (${((removedDuration / totalDuration) * 100).toFixed(1)}%)`);

    // Single-pass trim+concat filter to keep audio and video in sync
    console.log(`[${jobId}] Building filter chain for ${keepSegments.length} segments...`);

    const filterParts = [];
    const videoStreams = [];
    const audioStreams = [];

    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
      filterParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
      videoStreams.push(`[v${i}]`);
      audioStreams.push(`[a${i}]`);
    }

    filterParts.push(`${videoStreams.join('')}concat=n=${keepSegments.length}:v=1:a=0[outv]`);
    filterParts.push(`${audioStreams.join('')}concat=n=${keepSegments.length}:v=0:a=1[outa]`);

    const filterComplex = filterParts.join(';');

    const args = [
      '-y', '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath
    ];

    await runFFmpeg(args, jobId);
    console.log(`\n[${jobId}] Dead air removal complete`);

    // Read output file and send it back
    const outputStats = await stat(outputPath);
    console.log(`[${jobId}] Output file size: ${(outputStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[${jobId}] === DEAD AIR REMOVAL COMPLETE ===\n`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outputStats.size,
      'Access-Control-Allow-Origin': '*',
      'X-Removed-Duration': removedDuration.toFixed(2),
      'X-Original-Duration': totalDuration.toFixed(2),
      'X-New-Duration': totalKeptDuration.toFixed(2),
    });

    const readStream = createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on('close', () => {
      // Cleanup temp files
      try {
        unlinkSync(inputPath);
        unlinkSync(outputPath);
        unlinkSync(concatListPath);
        segmentPaths.forEach(p => { try { unlinkSync(p); } catch {} });
        console.log(`[${jobId}] Cleaned up temp files`);
      } catch (e) {
        console.error(`[${jobId}] Cleanup error:`, e.message);
      }
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);

    // Cleanup on error
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
    try { unlinkSync(concatListPath); } catch {}
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch {} });

    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function parseFFmpegArgs(command) {
  const args = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  // Remove 'ffmpeg' prefix if present
  command = command.replace(/^ffmpeg\s+/, '');

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

async function handleProcess(req, res) {
  const jobId = randomUUID();
  const inputPath = join(TEMP_DIR, `${jobId}-input.mp4`);
  const outputPath = join(TEMP_DIR, `${jobId}-output.mp4`);

  try {
    // Parse the multipart form
    const form = formidable({
      maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
      uploadDir: TEMP_DIR,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const videoFile = files.video?.[0];
    const command = fields.command?.[0];

    if (!videoFile || !command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing video or command' }));
      return;
    }

    // Rename uploaded file to our input path
    const { rename } = await import('fs/promises');
    await rename(videoFile.filepath, inputPath);

    console.log(`[${jobId}] Processing video with command: ${command}`);
    console.log(`[${jobId}] Input file size: ${(videoFile.size / 1024 / 1024).toFixed(1)} MB`);

    // Parse the FFmpeg command and replace input/output placeholders
    let args = parseFFmpegArgs(command);
    args = args.map(arg => {
      if (arg.match(/input\.[a-z0-9]+/i)) return inputPath;
      if (arg.match(/output\.[a-z0-9]+/i)) return outputPath;
      return arg;
    });

    // Add -y flag to overwrite output if not present
    if (!args.includes('-y')) {
      args.unshift('-y');
    }

    console.log(`[${jobId}] FFmpeg args:`, args);

    // Run FFmpeg
    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress lines
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') || line.includes('frame=')) {
          process.stdout.write(`\r[${jobId}] ${line.trim()}`);
        }
      }
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        console.log(`\n[${jobId}] FFmpeg exited with code ${code}`);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-500)}`));
        }
      });
      ffmpeg.on('error', reject);
    });

    // Read output file and send it back
    const { stat } = await import('fs/promises');
    const outputStats = await stat(outputPath);
    console.log(`[${jobId}] Output file size: ${(outputStats.size / 1024 / 1024).toFixed(1)} MB`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outputStats.size,
      'Access-Control-Allow-Origin': '*',
    });

    const readStream = createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on('close', () => {
      // Cleanup temp files
      try {
        unlinkSync(inputPath);
        unlinkSync(outputPath);
        console.log(`[${jobId}] Cleaned up temp files`);
      } catch (e) {
        console.error(`[${jobId}] Cleanup error:`, e.message);
      }
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);

    // Cleanup on error
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}

    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Format seconds to YouTube timestamp format (MM:SS or HH:MM:SS)
function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Auto-enhance: Analyse transcript and suggest overlay enhancements
// Uses FrameForge-inspired transcript intelligence (pure computation, no external deps)
async function handleAutoEnhance(req, res) {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { words, duration, width, height } = JSON.parse(body || '{}');

    if (!words || !words.length) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No words provided. Transcribe the video first.' }));
      return;
    }

    const durationMs = (duration || words[words.length - 1].end + 1) * 1000;

    // Build phrases from words (group by pauses)
    const phrases = [];
    let currentPhrase = [];
    for (let i = 0; i < words.length; i++) {
      currentPhrase.push(words[i]);
      const isLast = i === words.length - 1;
      const nextWord = isLast ? null : words[i + 1];
      const gap = nextWord ? nextWord.start - words[i].end : 1;

      if (gap > 0.5 || isLast) {
        phrases.push({
          text: currentPhrase.map(w => w.text).join(' '),
          startMs: Math.round(currentPhrase[0].start * 1000),
          endMs: Math.round(currentPhrase[currentPhrase.length - 1].end * 1000),
          startSec: currentPhrase[0].start,
          endSec: currentPhrase[currentPhrase.length - 1].end,
        });
        currentPhrase = [];
      }
    }

    // Detect pauses (gaps > 400ms)
    const pauses = [];
    for (let i = 0; i < words.length - 1; i++) {
      const gap = words[i + 1].start - words[i].end;
      if (gap >= 0.4) {
        pauses.push({
          startMs: Math.round(words[i].end * 1000),
          endMs: Math.round(words[i + 1].start * 1000),
          durationMs: Math.round(gap * 1000),
          type: gap > 1.5 ? 'transition' : gap > 0.6 ? 'beat' : 'breath',
        });
      }
    }

    // Detect stats (numbers, percentages, dollars)
    const stats = [];
    const statPatterns = [
      /\$[\d,.]+[BKMGT]?/gi,
      /\d+(\.\d+)?%/g,
      /\d+x\b/gi,
      /\b\d{2,}\+?\b/g,
    ];
    for (const phrase of phrases) {
      for (const pattern of statPatterns) {
        pattern.lastIndex = 0;
        const matches = phrase.text.match(pattern);
        if (matches) {
          for (const match of matches) {
            stats.push({
              value: match,
              text: phrase.text,
              startMs: phrase.startMs,
              endMs: phrase.endMs,
            });
          }
        }
      }
    }

    // Detect emphasis moments
    const emphasis = [];
    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i];
      const wordCount = p.text.split(/\s+/).length;
      let weight = 0;
      let reason = '';

      // Short punchy phrases (1-4 words)
      if (wordCount <= 4 && wordCount >= 1) { weight += 2; reason = 'short-phrase'; }
      // Phrase after a long pause
      if (i > 0 && pauses.some(pa => Math.abs(pa.endMs - p.startMs) < 200 && pa.type === 'transition')) {
        weight += 2; reason = reason || 'pause-before';
      }
      // Contains a stat
      if (stats.some(s => s.startMs === p.startMs)) { weight += 1; reason = reason || 'number'; }
      // ALL CAPS words
      if (/\b[A-Z]{2,}\b/.test(p.text)) { weight += 1; reason = reason || 'all-caps'; }

      if (weight >= 2) {
        emphasis.push({
          text: p.text,
          startMs: p.startMs,
          endMs: p.endMs,
          reason,
          weight,
        });
      }
    }

    // Build energy curve (words per second over 3s windows)
    const energyCurve = [];
    for (let t = 0; t < durationMs; t += 500) {
      const windowWords = words.filter(w => w.start * 1000 >= t && w.start * 1000 < t + 3000);
      const wps = Math.round(windowWords.length / 3 * 100) / 100;
      energyCurve.push({ timeMs: t, wps, isHigh: wps > 3.5, isLow: wps < 1.5 });
    }

    // Detect narrative structure (simple heuristic)
    const totalPhrases = phrases.length;
    const narrative = [];
    if (totalPhrases >= 4) {
      narrative.push({ type: 'hook', startMs: phrases[0].startMs, endMs: phrases[Math.min(1, totalPhrases - 1)].endMs });
      const setupEnd = Math.floor(totalPhrases * 0.3);
      narrative.push({ type: 'setup', startMs: phrases[2]?.startMs || 0, endMs: phrases[setupEnd]?.endMs || 0 });
      const climaxStart = Math.floor(totalPhrases * 0.7);
      narrative.push({ type: 'climax', startMs: phrases[climaxStart]?.startMs || 0, endMs: phrases[Math.min(climaxStart + 2, totalPhrases - 1)]?.endMs || 0 });
      narrative.push({ type: 'cta', startMs: phrases[totalPhrases - 2]?.startMs || 0, endMs: phrases[totalPhrases - 1]?.endMs || 0 });
    }

    // Generate overlay suggestions (pause-aligned)
    const suggestions = [];

    // Hook card in first 5s
    if (phrases.length > 0) {
      suggestions.push({
        type: 'hook-card',
        startMs: 200,
        endMs: Math.min(5000, phrases[0].endMs + 500),
        text: phrases[0].text,
        position: 'top-center',
      });
    }

    // Emphasis overlays at key moments
    for (const em of emphasis.slice(0, 5)) {
      suggestions.push({
        type: 'emphasis',
        startMs: em.startMs,
        endMs: em.endMs,
        text: em.text,
        reason: em.reason,
        weight: em.weight,
        position: 'top-center',
      });
    }

    // Stat callouts
    for (const st of stats.slice(0, 3)) {
      suggestions.push({
        type: 'stat-callout',
        startMs: st.startMs,
        endMs: st.endMs + 2000,
        text: st.value,
        context: st.text,
        position: 'top-right',
      });
    }

    // Chapter markers at transition pauses
    const transitionPauses = pauses.filter(p => p.type === 'transition');
    for (const tp of transitionPauses.slice(0, 4)) {
      const nextPhrase = phrases.find(p => p.startMs >= tp.endMs);
      if (nextPhrase) {
        suggestions.push({
          type: 'chapter-marker',
          startMs: tp.endMs,
          endMs: tp.endMs + 2500,
          text: nextPhrase.text.split(' ').slice(0, 5).join(' ') + '...',
          position: 'top-center',
        });
      }
    }

    // CTA at the end
    if (duration > 10) {
      suggestions.push({
        type: 'cta-card',
        startMs: (duration - 4) * 1000,
        endMs: (duration - 0.5) * 1000,
        text: 'Follow for more',
        position: 'top-center',
      });
    }

    const result = {
      intelligence: {
        pauses,
        stats,
        emphasis,
        narrative,
        speechStats: {
          totalWords: words.length,
          avgWordsPerSecond: Math.round(words.length / (duration || 1) * 100) / 100,
          totalPauses: pauses.length,
          longestPauseMs: pauses.length ? Math.max(...pauses.map(p => p.durationMs)) : 0,
        },
      },
      suggestions,
      phraseCount: phrases.length,
    };

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
    console.log(`[auto-enhance] Analysed ${words.length} words, ${phrases.length} phrases, ${suggestions.length} suggestions`);

  } catch (error) {
    console.error('Auto-enhance error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate chapters from video using AI
async function handleGenerateChapters(req, res) {
  const jobId = randomUUID();
  const inputPath = join(TEMP_DIR, `${jobId}-input.mp4`);
  const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

  try {
    // Check for API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured in .dev.vars' }));
      return;
    }

    // Parse the multipart form
    const form = formidable({
      maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
      uploadDir: TEMP_DIR,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const videoFile = files.video?.[0];
    if (!videoFile) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing video file' }));
      return;
    }

    // Rename uploaded file to our input path
    const { rename, stat } = await import('fs/promises');
    await rename(videoFile.filepath, inputPath);

    console.log(`\n[${jobId}] === CHAPTER GENERATION ===`);
    console.log(`[${jobId}] Input file size: ${(videoFile.size / 1024 / 1024).toFixed(1)} MB`);

    // Step 1: Get video duration
    const totalDuration = await getVideoDuration(inputPath);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    // Step 2: Extract audio as MP3 (compressed for faster upload to Gemini)
    console.log(`[${jobId}] Extracting audio...`);
    const extractArgs = [
      '-y',
      '-i', inputPath,
      '-vn',                    // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-ab', '64k',             // Lower bitrate for smaller file (speech doesn't need high quality)
      '-ar', '16000',           // 16kHz sample rate (good for speech)
      '-ac', '1',               // Mono
      audioPath
    ];
    await runFFmpeg(extractArgs, jobId);

    const audioStats = await stat(audioPath);
    console.log(`\n[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Step 3: Read audio file as base64
    console.log(`[${jobId}] Sending to Gemini for analysis...`);
    const audioBuffer = readFileSync(audioPath);
    const audioBase64 = audioBuffer.toString('base64');

    // Step 4: Send to Gemini for transcription and chapter analysis
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/mp3',
                data: audioBase64
              }
            },
            {
              text: `Analyze this audio from a video that is ${totalDuration.toFixed(1)} seconds long.

Your task is to identify logical chapter breaks based on topic changes, new sections, or natural transitions in the content.

For each chapter:
1. Identify the START timestamp (in seconds from the beginning)
2. Create a concise, descriptive title (2-6 words)

Guidelines:
- First chapter should always start at 0 seconds
- Aim for 3-8 chapters depending on content length and topic diversity
- Chapters should be at least 30 seconds apart
- Titles should be engaging and descriptive (good for YouTube)
- If the content is a tutorial, use action-oriented titles
- If it's a discussion, summarize the main topic of each section

Return your response as valid JSON with exactly this structure:
{
  "chapters": [
    { "start": 0, "title": "Introduction" },
    { "start": 45.5, "title": "Getting Started" },
    { "start": 120, "title": "Main Topic" }
  ],
  "summary": "Brief 1-2 sentence summary of the video content"
}

Only return the JSON, no other text.`
            }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json',
      }
    });

    const responseText = response.text || '{}';
    console.log(`[${jobId}] Gemini response received`);

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      // Try to extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : { chapters: [], summary: 'Failed to parse response' };
    }

    // Format chapters for YouTube
    const youtubeChapters = (result.chapters || [])
      .sort((a, b) => a.start - b.start)
      .map(ch => `${formatTimestamp(ch.start)} ${ch.title}`)
      .join('\n');

    console.log(`[${jobId}] Generated ${result.chapters?.length || 0} chapters`);
    console.log(`[${jobId}] === CHAPTER GENERATION COMPLETE ===\n`);

    // Return the chapters
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      success: true,
      chapters: result.chapters || [],
      youtubeFormat: youtubeChapters,
      summary: result.summary || '',
      videoDuration: totalDuration,
    }));

    // Cleanup
    try {
      unlinkSync(inputPath);
      unlinkSync(audioPath);
      console.log(`[${jobId}] Cleaned up temp files`);
    } catch (e) {
      console.error(`[${jobId}] Cleanup error:`, e.message);
    }

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);

    // Cleanup on error
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(audioPath); } catch {}

    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== SESSION-BASED HANDLERS ==============
// These keep videos on disk between edits for efficient large file handling

// Create a new empty session (for multi-asset workflow)
async function handleSessionCreate(req, res) {
  try {
    const session = createSession('Untitled Project');

    console.log(`[${session.id}] Empty session created`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      sessionId: session.id,
    }));

  } catch (error) {
    console.error('[Create] Error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Upload video and create a session
async function handleSessionUpload(req, res) {
  try {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB limit
      uploadDir: TEMP_DIR,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    const videoFile = files.video?.[0];

    if (!videoFile) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing video file' }));
      return;
    }

    // Create session and move file
    const session = createSession(videoFile.originalFilename || 'video.mp4');
    const { rename, stat } = await import('fs/promises');
    await rename(videoFile.filepath, session.currentVideo);

    const duration = await getVideoDuration(session.currentVideo);
    const stats = await stat(session.currentVideo);

    console.log(`[${session.id}] Video uploaded: ${(stats.size / 1024 / 1024).toFixed(1)} MB, ${duration.toFixed(2)}s`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      sessionId: session.id,
      duration,
      size: stats.size,
      name: session.originalName,
    }));

  } catch (error) {
    console.error('[Upload] Error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Stream video for preview (supports range requests for seeking)
async function handleSessionStream(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const { stat } = await import('fs/promises');
    const stats = await stat(session.currentVideo);
    const fileSize = stats.size;

    const range = req.headers.range;

    if (range) {
      // Handle range request for video seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
      });

      createReadStream(session.currentVideo, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(session.currentVideo).pipe(res);
    }
  } catch (error) {
    console.error(`[${sessionId}] Stream error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Get session info
async function handleSessionInfo(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const { stat } = await import('fs/promises');
    const stats = await stat(session.currentVideo);
    const duration = await getVideoDuration(session.currentVideo);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      sessionId: session.id,
      duration,
      size: stats.size,
      name: session.originalName,
      editCount: session.editCount,
      createdAt: session.createdAt,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Process video within a session (edit in place)
async function handleSessionProcess(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    // Parse JSON body
    let body = '';
    for await (const chunk of req) body += chunk;
    const { command } = JSON.parse(body);

    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const outputPath = join(session.dir, `output-${Date.now()}.mp4`);

    console.log(`\n[${sessionId}] Processing: ${command}`);

    // Parse and prepare FFmpeg command
    let args = parseFFmpegArgs(command);
    args = args.map(arg => {
      if (arg.match(/input\.[a-z0-9]+/i)) return session.currentVideo;
      if (arg.match(/output\.[a-z0-9]+/i)) return outputPath;
      return arg;
    });

    if (!args.includes('-y')) args.unshift('-y');

    console.log(`[${sessionId}] FFmpeg args:`, args.slice(0, 10).join(' '), '...');

    await runFFmpeg(args, sessionId);

    // Replace current video with output
    const { rename, stat } = await import('fs/promises');
    unlinkSync(session.currentVideo);
    await rename(outputPath, session.currentVideo);

    const newStats = await stat(session.currentVideo);
    const newDuration = await getVideoDuration(session.currentVideo);
    session.editCount++;

    console.log(`\n[${sessionId}] Edit complete. New duration: ${newDuration.toFixed(2)}s, Size: ${(newStats.size / 1024 / 1024).toFixed(1)} MB`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      duration: newDuration,
      size: newStats.size,
      editCount: session.editCount,
    }));

  } catch (error) {
    console.error(`[${sessionId}] Process error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Remove dead air within a session
async function handleSessionRemoveDeadAir(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId;
  const outputPath = join(session.dir, `deadair-output-${Date.now()}.mp4`);
  const concatListPath = join(session.dir, `concat-${Date.now()}.txt`);
  const segmentPaths = [];

  try {
    // Parse options from body
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const silenceThreshold = options.silenceThreshold || -30;
    const minSilenceDuration = options.minSilenceDuration || 0.3;

    console.log(`\n[${jobId}] === DEAD AIR REMOVAL (Session) ===`);

    // Find the original (non-AI-generated) video asset
    let videoAsset = null;
    for (const [assetId, asset] of session.assets) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }
    // Fallback to any video if no original found
    if (!videoAsset) {
      for (const [assetId, asset] of session.assets) {
        if (asset.type === 'video') {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session. Please upload a video first.' }));
      return;
    }

    // Verify the video file exists on disk
    if (!existsSync(videoAsset.path)) {
      console.error(`[${jobId}] Video file missing: ${videoAsset.path}`);
      res.writeHead(410, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        error: 'Video file no longer exists. Your session may have expired. Please re-upload your video.',
        code: 'VIDEO_FILE_MISSING'
      }));
      return;
    }

    console.log(`[${jobId}] Using video asset: ${videoAsset.filename} (${videoAsset.path})`);

    const totalDuration = await getVideoDuration(videoAsset.path);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    const silencePeriods = await detectSilence(videoAsset.path, jobId, {
      silenceThreshold,
      minSilenceDuration,
    });

    if (silencePeriods.length === 0) {
      console.log(`[${jobId}] No silence detected`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        success: true,
        duration: totalDuration,
        removedDuration: 0,
        message: 'No silence detected',
      }));
      return;
    }

    const keepSegments = calculateKeepSegments(silencePeriods, totalDuration);
    console.log(`[${jobId}] Keeping ${keepSegments.length} segments`);

    const totalKeptDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const removedDuration = totalDuration - totalKeptDuration;
    console.log(`[${jobId}] Removing ${removedDuration.toFixed(2)}s of dead air (${((removedDuration / totalDuration) * 100).toFixed(1)}%)`);

    // Extract segments
    console.log(`[${jobId}] Extracting segments...`);
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      const segmentPath = join(session.dir, `segment-${Date.now()}-${i}.mp4`);
      segmentPaths.push(segmentPath);

      const args = [
        '-y',
        '-ss', seg.start.toString(), // fast seek BEFORE -i (keyframe-accurate, no full decode)
        '-i', videoAsset.path,
        '-t', (seg.end - seg.start).toString(),
        '-c', 'copy', // stream copy — no re-encoding needed for silence removal
        segmentPath
      ];

      await runFFmpeg(args, jobId);
      console.log(`\n[${jobId}] Segment ${i + 1}/${keepSegments.length}`);
    }

    // Concatenate
    const concatList = segmentPaths.map(p => `file '${p}'`).join('\n');
    writeFileSync(concatListPath, concatList);

    console.log(`[${jobId}] Concatenating...`);
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', outputPath], jobId);

    console.log(`\n[${jobId}] Dead air removal complete`);

    // Verify output has audio before replacing original
    const probeResult = execSync(
      `ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "${outputPath}"`,
      { encoding: 'utf-8' }
    );
    const streams = probeResult.trim().split('\n');
    console.log(`\n🔍 [${jobId}] OUTPUT FILE PROBE:`);
    console.log(`🔍 [${jobId}]   Streams: ${streams.join(', ')}`);
    console.log(`🔍 [${jobId}]   Has video: ${streams.includes('video')}`);
    console.log(`🔍 [${jobId}]   Has audio: ${streams.includes('audio')}`);
    console.log(`🔍 [${jobId}]   Output path: ${outputPath}`);

    // Also probe the ORIGINAL file for comparison
    const origProbe = execSync(
      `ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "${videoAsset.path}"`,
      { encoding: 'utf-8' }
    );
    console.log(`🔍 [${jobId}]   Original streams: ${origProbe.trim().split('\n').join(', ')}`);

    // Cleanup segments
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch {} });
    try { unlinkSync(concatListPath); } catch {}

    // Replace the video asset file
    const { rename, stat } = await import('fs/promises');
    unlinkSync(videoAsset.path);
    await rename(outputPath, videoAsset.path);

    // Cleanup segments
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch {} });
    try { unlinkSync(concatListPath); } catch {}

    const newStats = await stat(videoAsset.path);

    // Update the video asset metadata
    videoAsset.duration = totalKeptDuration;
    videoAsset.size = newStats.size;

    // Persist updated duration so it survives a server restart
    saveAssetMetadata(session);

    session.editCount++;

    console.log(`\n[${jobId}] === DEAD AIR REMOVAL COMPLETE ===`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      duration: totalKeptDuration,
      originalDuration: totalDuration,
      removedDuration,
      size: newStats.size,
      editCount: session.editCount,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch {} });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate chapters for a session
async function handleSessionChapters(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId;
  const audioPath = join(session.dir, `audio-${Date.now()}.mp3`);

  // Parse optional pre-built transcript from body (skips audio extraction)
  let preBuiltTranscript = null;
  try {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > 0) {
      const bodyData = await new Promise((resolve) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
      });
      preBuiltTranscript = bodyData.transcript || null;
    }
  } catch { /* ignore */ }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    console.log(`\n[${jobId}] === CHAPTER GENERATION (Session) ===`);

    // --- Fast path: use pre-built transcript from caption data ---
    if (preBuiltTranscript) {
      console.log(`[${jobId}] Using pre-built transcript (${preBuiltTranscript.length} chars) — skipping audio extraction`);

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [{ text: `Analyze this video transcript with word-level timestamps and identify logical chapter breaks based on topic changes or natural transitions.\n\nTranscript (format: [time] word):\n${preBuiltTranscript}\n\nFor each chapter:\n1. START timestamp (seconds, must match a timestamp from the transcript)\n2. Concise, descriptive title (2-6 words)\n\nGuidelines:\n- First chapter starts at 0\n- Aim for 3-8 chapters\n- At least 30 seconds apart\n- Engaging titles for YouTube\n\nReturn JSON: {"chapters": [{"start": 0, "title": "Introduction"}], "summary": "Brief summary"}` }]
        }],
        config: { responseMimeType: 'application/json' }
      });

      let responseText = '';
      if (typeof response.text === 'function') responseText = await response.text();
      else if (response.text) responseText = response.text;
      else if (response.candidates?.[0]?.content?.parts?.[0]?.text) responseText = response.candidates[0].content.parts[0].text;

      let result;
      try { result = JSON.parse(responseText || '{}'); }
      catch { const m = (responseText || '').match(/\{[\s\S]*\}/); result = m ? JSON.parse(m[0]) : { chapters: [], summary: '' }; }

      if (!result.chapters || result.chapters.length === 0) {
        result.chapters = [{ start: 0, title: 'Introduction' }];
      }

      const youtubeChapters = (result.chapters || [])
        .sort((a, b) => a.start - b.start)
        .map(ch => `${formatTimestamp(ch.start)} ${ch.title}`)
        .join('\n');

      console.log(`[${jobId}] Generated ${result.chapters.length} chapters from transcript`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        success: true,
        chapters: result.chapters || [],
        youtubeFormat: youtubeChapters,
        summary: result.summary || '',
        videoDuration: 0,
        source: 'captions',
      }));
      return;
    }

    // --- Standard path: extract audio + send to Gemini ---
    // Find video path - check both legacy currentVideo and new assets system
    let videoPath = session.currentVideo;
    if (!videoPath || !existsSync(videoPath)) {
      // Try to find original (non-AI) video from assets
      if (session.assets && session.assets.size > 0) {
        for (const [, asset] of session.assets) {
          if (asset.type === 'video' && !asset.aiGenerated && existsSync(asset.path)) {
            videoPath = asset.path;
            console.log(`[${jobId}] Using video asset: ${asset.filename}`);
            break;
          }
        }
        // Fallback to any video
        if (!videoPath || !existsSync(videoPath)) {
          for (const [, asset] of session.assets) {
            if (asset.type === 'video' && existsSync(asset.path)) {
              videoPath = asset.path;
              console.log(`[${jobId}] Using video asset (fallback): ${asset.filename}`);
              break;
            }
          }
        }
      }
    }

    if (!videoPath || !existsSync(videoPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video found in session. Please upload a video first.' }));
      return;
    }

    const totalDuration = await getVideoDuration(videoPath);

    // Extract audio
    console.log(`[${jobId}] Extracting audio from: ${videoPath}`);
    await runFFmpeg(['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-ar', '16000', '-ac', '1', audioPath], jobId);

    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    console.log(`\n[${jobId}] Audio: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Send to Gemini
    console.log(`[${jobId}] Analyzing with Gemini...`);
    const audioBuffer = readFileSync(audioPath);
    const audioBase64 = audioBuffer.toString('base64');

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
          { text: `Analyze this audio from a video that is ${totalDuration.toFixed(1)} seconds long.

Identify logical chapter breaks based on topic changes or natural transitions.

For each chapter:
1. START timestamp (seconds from beginning)
2. Concise, descriptive title (2-6 words)

Guidelines:
- First chapter starts at 0
- Aim for 3-8 chapters
- At least 30 seconds apart
- Engaging titles for YouTube

Return JSON: {"chapters": [{"start": 0, "title": "Introduction"}], "summary": "Brief summary"}` }
        ]
      }],
      config: { responseMimeType: 'application/json' }
    });

    // Get the response text - handle different SDK versions
    let responseText = '';
    if (typeof response.text === 'function') {
      responseText = await response.text();
    } else if (response.text) {
      responseText = response.text;
    } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      responseText = response.candidates[0].content.parts[0].text;
    }

    console.log(`[${jobId}] Gemini response:`, responseText.substring(0, 500));

    let result;
    try {
      result = JSON.parse(responseText || '{}');
    } catch {
      const match = (responseText || '').match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : { chapters: [], summary: '' };
    }

    // If no chapters detected, create automatic chapters based on duration
    if (!result.chapters || result.chapters.length === 0) {
      console.log(`[${jobId}] No chapters from AI, creating automatic chapters...`);

      // Create chapters every ~60 seconds, or split into 4-6 sections
      const chapterInterval = Math.max(30, Math.min(90, totalDuration / 5));
      const autoChapters = [];

      for (let time = 0; time < totalDuration - 10; time += chapterInterval) {
        const chapterNum = autoChapters.length + 1;
        autoChapters.push({
          start: Math.round(time * 10) / 10,
          title: time === 0 ? 'Introduction' : `Part ${chapterNum}`
        });
      }

      result.chapters = autoChapters;
      result.summary = 'Auto-generated chapters based on video duration';
      console.log(`[${jobId}] Created ${autoChapters.length} automatic chapters`);
    }

    const youtubeChapters = (result.chapters || [])
      .sort((a, b) => a.start - b.start)
      .map(ch => `${formatTimestamp(ch.start)} ${ch.title}`)
      .join('\n');

    // Cleanup
    try { unlinkSync(audioPath); } catch {}

    console.log(`[${jobId}] Generated ${result.chapters?.length || 0} chapters`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      chapters: result.chapters || [],
      youtubeFormat: youtubeChapters,
      summary: result.summary || '',
      videoDuration: totalDuration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { unlinkSync(audioPath); } catch {}
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Download final video
async function handleSessionDownload(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const { stat } = await import('fs/promises');
    const stats = await stat(session.currentVideo);

    const filename = session.originalName.replace(/\.[^.]+$/, '-edited.mp4');

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    });

    createReadStream(session.currentVideo).pipe(res);
    console.log(`[${sessionId}] Downloading: ${filename}`);

  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Delete session
function handleSessionDelete(req, res, sessionId) {
  cleanupSession(sessionId);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true }));
}

// ============== MULTI-ASSET HANDLERS ==============

// Generate thumbnail for video/image asset
async function generateThumbnail(inputPath, outputPath, isImage = false) {
  if (isImage) {
    // For images, just resize
    const args = [
      '-y', '-i', inputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      outputPath
    ];
    await runFFmpeg(args, 'thumb');
  } else {
    // For videos, extract frame at 1 second or 10% of duration
    const duration = await getVideoDuration(inputPath);
    const seekTime = Math.min(1, duration * 0.1);
    const args = [
      '-y', '-ss', seekTime.toString(),
      '-i', inputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      outputPath
    ];
    await runFFmpeg(args, 'thumb');
  }
}

// Get video/image dimensions
async function getMediaInfo(inputPath) {
  try {
    const result = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of json "${inputPath}"`,
      { encoding: 'utf-8' }
    );
    const info = JSON.parse(result);
    const stream = info.streams?.[0] || {};
    let duration = parseFloat(stream.duration) || 0;
    // Stream-level duration is absent for some containers (screen recordings, -c copy output, etc.)
    // Fall back to format-level duration which is always reliable
    if (!duration) {
      try {
        const fmtResult = execSync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
          { encoding: 'utf-8' }
        );
        duration = parseFloat(fmtResult.trim()) || 0;
      } catch {}
    }
    return {
      width: stream.width || 0,
      height: stream.height || 0,
      duration,
    };
  } catch {
    // If stream probe fails entirely, try format-level as last resort
    try {
      const fmtResult = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
        { encoding: 'utf-8' }
      );
      return { width: 0, height: 0, duration: parseFloat(fmtResult.trim()) || 0 };
    } catch {
      return { width: 0, height: 0, duration: 0 };
    }
  }
}

// Upload asset to session
async function handleAssetUpload(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
      uploadDir: session.assetsDir,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    const uploadedFile = files.file?.[0] || files.video?.[0];

    if (!uploadedFile) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Missing file' }));
      return;
    }

    const assetId = randomUUID();
    const originalName = uploadedFile.originalFilename || 'file';
    const ext = originalName.split('.').pop()?.toLowerCase() || 'mp4';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const isAudio = ['mp3', 'wav', 'aac', 'm4a', 'ogg'].includes(ext);
    const type = isImage ? 'image' : isAudio ? 'audio' : 'video';

    // Move file to proper location
    const assetPath = join(session.assetsDir, `${assetId}.${ext}`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    const { rename, stat } = await import('fs/promises');
    await rename(uploadedFile.filepath, assetPath);

    // Get media info
    let duration = 0;
    let width = 0;
    let height = 0;

    if (!isAudio) {
      const info = await getMediaInfo(assetPath);
      duration = info.duration;
      width = info.width;
      height = info.height;
    } else {
      duration = await getVideoDuration(assetPath);
    }

    // Generate thumbnail (for video/image)
    if (!isAudio) {
      try {
        await generateThumbnail(assetPath, thumbPath, isImage);
      } catch (e) {
        console.warn(`[${sessionId}] Thumbnail generation failed:`, e.message);
      }
    }

    const stats = await stat(assetPath);

    const asset = {
      id: assetId,
      type,
      filename: originalName,
      path: assetPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: isImage ? 5 : duration, // Default 5s for images
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${sessionId}] Asset uploaded: ${assetId} (${type}, ${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      asset: {
        id: asset.id,
        type: asset.type,
        filename: asset.filename,
        duration: asset.duration,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${assetId}/thumbnail` : null,
      },
    }));

  } catch (error) {
    console.error(`[${sessionId}] Asset upload error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// List all assets in session
function handleAssetList(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const assets = Array.from(session.assets.values()).map(asset => ({
    id: asset.id,
    type: asset.type,
    filename: asset.filename,
    duration: asset.duration,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${asset.id}/thumbnail` : null,
    aiGenerated: asset.aiGenerated || false, // True for Remotion-generated animations
  }));

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ assets }));
}

// Delete asset
function handleAssetDelete(req, res, sessionId, assetId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const asset = session.assets.get(assetId);
  if (!asset) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Asset not found' }));
    return;
  }

  // Remove files
  try {
    if (existsSync(asset.path)) unlinkSync(asset.path);
    if (asset.thumbPath && existsSync(asset.thumbPath)) unlinkSync(asset.thumbPath);
  } catch (e) {
    console.warn(`[${sessionId}] Asset file cleanup failed:`, e.message);
  }

  // Remove from session
  session.assets.delete(assetId);
  saveAssetMetadata(session); // Update metadata file

  // Remove any clips using this asset
  session.project.clips = session.project.clips.filter(clip => clip.assetId !== assetId);

  console.log(`[${sessionId}] Asset deleted: ${assetId}`);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true }));
}

// Get asset thumbnail
async function handleAssetThumbnail(req, res, sessionId, assetId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const asset = session.assets.get(assetId);
  if (!asset || !asset.thumbPath || !existsSync(asset.thumbPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Thumbnail not found' }));
    return;
  }

  const { stat } = await import('fs/promises');
  const stats = await stat(asset.thumbPath);

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stats.size,
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });

  createReadStream(asset.thumbPath).pipe(res);
}

// Get audio waveform data for asset
async function handleAssetWaveform(req, res, sessionId, assetId, url) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Asset not found' }));
    return;
  }

  // Only process audio or video assets
  if (asset.type !== 'audio' && asset.type !== 'video') {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Asset must be audio or video' }));
    return;
  }

  // Check for cached waveform
  const waveformPath = join(session.assetsDir, `${assetId}_waveform.json`);
  if (existsSync(waveformPath)) {
    try {
      const cached = JSON.parse(readFileSync(waveformPath, 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cached));
      return;
    } catch (e) {
      // Cache invalid, regenerate
    }
  }

  // Get number of samples from query param (default 200)
  const numSamples = Math.min(Math.max(parseInt(url.searchParams.get('samples') || '200'), 50), 1000);

  try {
    console.log(`[${sessionId}] Generating waveform for asset ${assetId}...`);

    // Use ffmpeg to extract audio samples
    // -af "aformat=channel_layouts=mono,compand" normalizes audio
    // -f data outputs raw audio samples
    const ffprobeCmd = `ffprobe -v error -select_streams a:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${asset.path}"`;

    let audioDuration = 0;
    try {
      const durationResult = execSync(ffprobeCmd, { encoding: 'utf-8' });
      audioDuration = parseFloat(durationResult.trim()) || asset.duration || 10;
    } catch {
      audioDuration = asset.duration || 10;
    }

    // Calculate samples per segment
    const segmentDuration = audioDuration / numSamples;

    // Use ffmpeg to get peak values for each segment
    // This creates a temp file with audio samples, then we analyze it
    const tempPcmPath = join(session.assetsDir, `${assetId}_temp.raw`);

    // Extract audio as raw PCM mono 8-bit, downsampled to 8000Hz for efficiency
    const ffmpegCmd = `ffmpeg -y -i "${asset.path}" -ac 1 -ar 8000 -f u8 "${tempPcmPath}"`;

    try {
      execSync(ffmpegCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      // FFmpeg outputs to stderr even on success, ignore
    }

    if (!existsSync(tempPcmPath)) {
      throw new Error('Failed to extract audio data');
    }

    // Read raw audio and compute RMS values for each segment
    const rawAudio = readFileSync(tempPcmPath);
    const totalSamples = rawAudio.length;
    const samplesPerSegment = Math.floor(totalSamples / numSamples);

    const waveformData = [];

    for (let i = 0; i < numSamples; i++) {
      const start = i * samplesPerSegment;
      const end = Math.min(start + samplesPerSegment, totalSamples);

      // Calculate RMS (root mean square) for this segment
      let sumSquares = 0;
      for (let j = start; j < end; j++) {
        // Convert unsigned 8-bit (0-255) to signed (-128 to 127), then normalize to -1 to 1
        const sample = (rawAudio[j] - 128) / 128;
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / (end - start || 1));

      // Normalize to 0-1 range and apply slight curve for better visualization
      const normalized = Math.min(1, rms * 2.5);
      waveformData.push(Math.round(normalized * 1000) / 1000);
    }

    // Clean up temp file
    try {
      unlinkSync(tempPcmPath);
    } catch {}

    const result = {
      assetId,
      duration: audioDuration,
      samples: waveformData,
      sampleCount: numSamples,
    };

    // Cache the result
    writeFileSync(waveformPath, JSON.stringify(result));

    console.log(`[${sessionId}] Waveform generated: ${numSamples} samples`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error(`[${sessionId}] Waveform generation failed:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Stream asset
async function handleAssetStream(req, res, sessionId, assetId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Asset not found' }));
    return;
  }

  const { stat } = await import('fs/promises');
  const stats = await stat(asset.path);
  const fileSize = stats.size;

  // Get proper MIME type for the asset
  const getContentType = () => {
    if (asset.type === 'image') {
      const ext = asset.path.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
      };
      return mimeTypes[ext] || 'image/jpeg';
    }
    if (asset.type === 'audio') {
      const ext = asset.path.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'm4a': 'audio/mp4',
        'aac': 'audio/aac',
      };
      return mimeTypes[ext] || 'audio/mpeg';
    }
    return 'video/mp4';
  };
  const contentType = getContentType();

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Clamp values to valid range (prevents crash if file size changed)
    if (start >= fileSize) {
      // Requested range is completely outside file - return 416
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }
    if (end >= fileSize) {
      end = fileSize - 1;
    }
    if (start > end) {
      start = end;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });

    createReadStream(asset.path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(asset.path).pipe(res);
  }
}

// Get project state
function handleProjectGet(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  // Verify the session directory still exists on disk
  if (!existsSync(session.dir)) {
    console.log(`[Session] Directory missing for ${sessionId}, cleaning up`);
    sessions.delete(sessionId);
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session files no longer exist' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    tracks: session.project.tracks,
    clips: session.project.clips,
    settings: session.project.settings,
    captionData: session.project.captionData || {},
  }));
}

// Save project state
async function handleProjectSave(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);

    if (data.tracks) session.project.tracks = data.tracks;
    if (data.clips) session.project.clips = data.clips;
    if (data.settings) session.project.settings = { ...session.project.settings, ...data.settings };
    if (data.captionData) session.project.captionData = data.captionData;
    if (data.frameTemplate) session.project.frameTemplate = data.frameTemplate;
    if (data.overlayAssets) session.project.overlayAssets = data.overlayAssets;

    // Save to disk for persistence
    const projectPath = join(session.dir, 'project.json');
    writeFileSync(projectPath, JSON.stringify(session.project, null, 2));

    console.log(`[${sessionId}] Project saved: ${session.project.clips.length} clips`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true }));

  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Render project to video
async function handleProjectRender(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};
    const isPreview = options.preview === true;

    const clips = session.project.clips;
    const settings = session.project.settings;

    if (clips.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No clips in timeline' }));
      return;
    }

    console.log(`\n[${sessionId}] === RENDER ${isPreview ? 'PREVIEW' : 'EXPORT'} ===`);
    console.log(`[${sessionId}] ${clips.length} clips, ${settings.width}x${settings.height}`);

    // Sort clips by track for layering (V1 first, then V2, etc.)
    const videoClips = clips
      .filter(c => session.assets.get(c.assetId)?.type !== 'audio')
      .sort((a, b) => {
        const trackOrder = { 'V1': 0, 'V2': 1, 'V3': 2 };
        return (trackOrder[a.trackId] || 0) - (trackOrder[b.trackId] || 0);
      });

    const audioClips = clips
      .filter(c => session.assets.get(c.assetId)?.type === 'audio');

    // DEBUG: log every clip to file so we can diagnose render issues
    const renderDebugLines = [`=== RENDER DEBUG ${new Date().toISOString()} ===`];
    renderDebugLines.push(`All clips (${clips.length} total):`);
    for (const c of clips) {
      const a = session.assets.get(c.assetId);
      renderDebugLines.push(`  track=${c.trackId} assetId=${c.assetId || '(empty)'} type=${a?.type || 'NOT FOUND'} aiGenerated=${a?.aiGenerated} start=${c.start} duration=${c.duration} inPoint=${c.inPoint} outPoint=${c.outPoint} path=${a?.path || 'N/A'}`);
    }
    renderDebugLines.push(`videoClips after filter: ${videoClips.length}, audioClips: ${audioClips.length}`);
    console.log(renderDebugLines.join('\n'));

    // Calculate total duration from all clips
    const totalDuration = Math.max(
      ...clips.map(c => c.start + c.duration),
      0.1
    );

    // Build FFmpeg filter_complex
    const inputs = [];
    const filterParts = [];
    let inputIndex = 0;

    // Get frame template if present (for 9:16 vertical video styling)
    const frameTemplate = session.project.frameTemplate;
    const overlayAssets = session.project.overlayAssets || [];

    console.log(`[${sessionId}] Frame template:`, frameTemplate ? JSON.stringify(frameTemplate).substring(0, 200) : 'NONE');
    console.log(`[${sessionId}] Overlay assets: ${overlayAssets.length} assets`);
    if (frameTemplate && frameTemplate.overlays) {
      console.log(`[${sessionId}] Frame template has ${frameTemplate.overlays.length} overlays`);
      for (const ov of frameTemplate.overlays) {
        console.log(`[${sessionId}]   Overlay: type=${ov.type}, assetId=${ov.assetId || 'none'}`);
      }
    }

    // Helper to write base64 data URL to temp file
    const writeBase64ToTempFile = (dataUrl, filename) => {
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) return null;
      const buffer = Buffer.from(matches[2], 'base64');
      const tempPath = join(session.dir, 'temp_' + filename);
      writeFileSync(tempPath, buffer);
      return tempPath;
    };

    // Create background based on frame template
    let backgroundFilter;
    if (frameTemplate && frameTemplate.background) {
      const bg = frameTemplate.background;
      if (bg.type === 'solid') {
        // Solid color background
        const color = (bg.color || '#000000').replace('#', '');
        backgroundFilter = `color=0x${color}:s=${settings.width}x${settings.height}:d=${totalDuration}:r=${settings.fps}[base]`;
      } else if (bg.type === 'gradient') {
        // Gradient background using gradients filter
        const start = (bg.gradientStart || '#1a1a2e').replace('#', '');
        const end = (bg.gradientEnd || '#16213e').replace('#', '');
        const angle = bg.gradientAngle || 180;
        // FFmpeg gradients filter: gradients=s=WxH:c0=color1:c1=color2:x0=x:y0=y:x1=x:y1=y
        // Calculate gradient direction based on angle
        const radians = (angle - 90) * Math.PI / 180;
        const x0 = Math.round(settings.width / 2 + Math.cos(radians) * settings.width / 2);
        const y0 = Math.round(settings.height / 2 + Math.sin(radians) * settings.height / 2);
        const x1 = Math.round(settings.width / 2 - Math.cos(radians) * settings.width / 2);
        const y1 = Math.round(settings.height / 2 - Math.sin(radians) * settings.height / 2);
        backgroundFilter = `gradients=s=${settings.width}x${settings.height}:c0=0x${start}:c1=0x${end}:x0=${x0}:y0=${y0}:x1=${x1}:y1=${y1}:d=${totalDuration}:r=${settings.fps}[base]`;
      } else {
        // Default to black for blur/image (handled separately)
        backgroundFilter = `color=black:s=${settings.width}x${settings.height}:d=${totalDuration}:r=${settings.fps}[base]`;
      }
    } else {
      // Default black background
      backgroundFilter = `color=black:s=${settings.width}x${settings.height}:d=${totalDuration}:r=${settings.fps}[base]`;
    }
    filterParts.push(backgroundFilter);
    let lastVideo = 'base';

    // Handle blur background - needs to use first video clip scaled and blurred
    if (frameTemplate && frameTemplate.background && frameTemplate.background.type === 'blur') {
      const blurAmount = frameTemplate.background.blurAmount || 20;
      // Find the first V1 video clip for blur background
      const v1Clip = videoClips.find(c => c.trackId === 'V1');
      if (v1Clip) {
        const v1Asset = session.assets.get(v1Clip.assetId);
        if (v1Asset && v1Asset.type === 'video') {
          inputs.push('-i', v1Asset.path);
          const blurIdx = inputIndex++;
          const inPoint = v1Clip.inPoint || 0;
          const outPoint = v1Clip.outPoint || v1Asset.duration;
          // Scale to fill (cover), blur, and use as background
          filterParts.push(`[${blurIdx}:v]trim=${inPoint}:${outPoint},setpts=PTS-STARTPTS+(${v1Clip.start}/TB),scale=${settings.width}:${settings.height}:force_original_aspect_ratio=increase,crop=${settings.width}:${settings.height},gblur=sigma=${blurAmount}[blurbg]`);
          filterParts.push(`[base][blurbg]overlay=0:0:enable='between(t,${v1Clip.start},${v1Clip.start + (outPoint - inPoint)})'[blurbase]`);
          lastVideo = 'blurbase';
        }
      }
    }

    // Handle image background
    if (frameTemplate && frameTemplate.background && frameTemplate.background.type === 'image' && frameTemplate.background.imageAssetId) {
      let bgPath = null;
      const bgOverlayAsset = overlayAssets.find(a => a.id === frameTemplate.background.imageAssetId);

      if (bgOverlayAsset && bgOverlayAsset.dataUrl) {
        // Client sent base64 data
        bgPath = writeBase64ToTempFile(bgOverlayAsset.dataUrl, 'bg_image.png');
      } else if (session.assets && session.assets.has(frameTemplate.background.imageAssetId)) {
        // Look up from session assets (server-side storage)
        const sessionAsset = session.assets.get(frameTemplate.background.imageAssetId);
        if (sessionAsset && sessionAsset.path && existsSync(sessionAsset.path)) {
          bgPath = sessionAsset.path;
          console.log(`[${sessionId}] Using session asset for background: ${bgPath}`);
        }
      }

      if (bgPath) {
        inputs.push('-loop', '1', '-i', bgPath);
        const bgIdx = inputIndex++;
        // Scale image to fill frame
        filterParts.push(`[${bgIdx}:v]scale=${settings.width}:${settings.height}:force_original_aspect_ratio=increase,crop=${settings.width}:${settings.height}[imgbg]`);
        filterParts.push(`[base][imgbg]overlay=0:0[imgbase]`);
        lastVideo = 'imgbase';
      } else {
        console.log(`[${sessionId}] Background image asset not found: ${frameTemplate.background.imageAssetId}`);
      }
    }

    // Map transition types to FFmpeg xfade transition names
    const XFADE_MAP = {
      'crossfade': 'fade',
      'wipe-left': 'wipeleft',
      'wipe-right': 'wiperight',
      'wipe-up': 'wipeup',
      'wipe-down': 'wipedown',
      'slide-left': 'slideleft',
      'slide-right': 'slideright',
      'zoom-in': 'circlecrop',
      'zoom-out': 'fadeblack',
    };

    // Separate V1 clips from overlay clips (V2, V3)
    const v1Clips = videoClips.filter(c => c.trackId === 'V1').sort((a, b) => a.start - b.start);
    const overlayVideoClips = videoClips.filter(c => c.trackId !== 'V1');
    const hasAnyTransitions = v1Clips.some(c => c.transition && c.transition.type && c.transition.type !== 'none');

    // Process V1 clips
    const videoInputIndices = []; // track idx + asset for audio mixing later

    if (hasAnyTransitions && v1Clips.length >= 2) {
      // === TRANSITION PATH: Pre-compose V1 clips using xfade ===
      console.log(`[${sessionId}] Using xfade transition path for ${v1Clips.length} V1 clips`);

      const v1Labels = [];
      const v1Durations = [];

      // Step 1: Add inputs and build trimmed/scaled streams for each V1 clip
      for (let i = 0; i < v1Clips.length; i++) {
        const clip = v1Clips[i];
        const asset = session.assets.get(clip.assetId);
        if (!asset) continue;

        if (asset.type === 'image') {
          const isGif = /\.gif$/i.test(asset.path);
          if (isGif) {
            inputs.push('-ignore_loop', '0');
          } else {
            inputs.push('-loop', '1');
          }
        }
        inputs.push('-i', asset.path);
        const idx = inputIndex++;
        videoInputIndices.push({ clip, asset, idx });

        const inPoint = clip.inPoint || 0;
        const outPoint = clip.outPoint || clip.duration || asset.duration;
        const trimDuration = outPoint - inPoint;

        // Trim and scale WITHOUT PTS timeline shift (xfade handles timing internally)
        let clipFilter = `[${idx}:v]trim=${inPoint}:${outPoint},setpts=PTS-STARTPTS,`;
        clipFilter += `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,`;
        clipFilter += `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2`;
        clipFilter += `[v1_${i}]`;
        filterParts.push(clipFilter);

        v1Labels.push(`v1_${i}`);
        v1Durations.push(trimDuration);
      }

      // Step 2: Chain V1 clips using xfade (transitions) or concat (hard cuts)
      let composedLabel = v1Labels[0];
      let composedDuration = v1Durations[0];

      for (let i = 1; i < v1Clips.length; i++) {
        if (!v1Labels[i]) continue; // Skip if asset was missing
        const clip = v1Clips[i];
        const tr = clip.transition;
        const clipDuration = v1Durations[i];

        if (tr && tr.type !== 'none' && XFADE_MAP[tr.type]) {
          // xfade transition between clips
          const xfadeType = XFADE_MAP[tr.type];
          const trDur = Math.min(tr.duration, composedDuration * 0.4, clipDuration * 0.4); // Safety clamp
          const offset = Math.max(0, composedDuration - trDur);

          console.log(`[${sessionId}] xfade: ${composedLabel} -> ${v1Labels[i]}, type=${xfadeType}, duration=${trDur}s, offset=${offset}s`);
          filterParts.push(`[${composedLabel}][${v1Labels[i]}]xfade=transition=${xfadeType}:duration=${trDur}:offset=${offset}[xf${i}]`);
          composedLabel = `xf${i}`;
          composedDuration = composedDuration + clipDuration - trDur;
        } else {
          // Hard cut — use concat
          filterParts.push(`[${composedLabel}][${v1Labels[i]}]concat=n=2:v=1:a=0[cc${i}]`);
          composedLabel = `cc${i}`;
          composedDuration += clipDuration;
        }
      }

      // Step 3: Shift PTS to align composed V1 with timeline position and overlay onto base
      const firstStart = v1Clips[0].start;
      if (firstStart > 0) {
        filterParts.push(`[${composedLabel}]setpts=PTS+(${firstStart}/TB)[v1composed]`);
        composedLabel = 'v1composed';
      }
      const v1Enable = `between(t,${firstStart},${firstStart + composedDuration})`;
      filterParts.push(`[${lastVideo}][${composedLabel}]overlay=x=(W-w)/2:y=(H-h)/2:enable='${v1Enable}'[v1out]`);
      lastVideo = 'v1out';

    } else {
      // === STANDARD PATH: No transitions — overlay V1 clips individually ===
      for (const clip of v1Clips) {
        const asset = session.assets.get(clip.assetId);
        if (!asset) continue;

        if (asset.type === 'image') {
          const isGif = /\.gif$/i.test(asset.path);
          if (isGif) {
            inputs.push('-ignore_loop', '0');
          } else {
            inputs.push('-loop', '1');
          }
        }
        inputs.push('-i', asset.path);
        const idx = inputIndex++;
        videoInputIndices.push({ clip, asset, idx });

        const inPoint = clip.inPoint || 0;
        const outPoint = clip.outPoint || clip.duration || asset.duration;
        const trimDuration = outPoint - inPoint;

        let clipFilter = `[${idx}:v]`;
        clipFilter += `trim=${inPoint}:${outPoint},setpts=PTS-STARTPTS+(${clip.start}/TB),`;
        clipFilter += `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,`;
        clipFilter += `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2`;
        clipFilter += `[v${idx}]`;
        filterParts.push(clipFilter);

        const enable = `between(t,${clip.start},${clip.start + trimDuration})`;
        filterParts.push(`[${lastVideo}][v${idx}]overlay=x=(W-w)/2:y=(H-h)/2:enable='${enable}'[out${idx}]`);
        lastVideo = `out${idx}`;
      }
    }

    // Process overlay video clips (V2, V3)
    for (const clip of overlayVideoClips) {
      const asset = session.assets.get(clip.assetId);
      if (!asset) continue;

      if (asset.type === 'image') {
        const isGif = /\.gif$/i.test(asset.path);
        if (isGif) {
          inputs.push('-ignore_loop', '0');
        } else {
          inputs.push('-loop', '1');
        }
      }
      inputs.push('-i', asset.path);
      const idx = inputIndex++;
      videoInputIndices.push({ clip, asset, idx });

      const inPoint = clip.inPoint || 0;
      const outPoint = clip.outPoint || clip.duration || asset.duration;
      const trimDuration = outPoint - inPoint;

      let clipFilter = `[${idx}:v]`;
      clipFilter += `trim=${inPoint}:${outPoint},setpts=PTS-STARTPTS+(${clip.start}/TB),`;

      const transformScale = clip.transform?.scale ?? 0.2;
      const targetWidth = Math.round(settings.width * transformScale);
      clipFilter += `scale=${targetWidth}:-1`;
      console.log(`[${sessionId}] Overlay ${clip.trackId}: scale=${transformScale}, targetWidth=${targetWidth}`);

      clipFilter += `[v${idx}]`;
      filterParts.push(clipFilter);

      const xOffset = clip.transform?.x ?? 0;
      const yOffset = clip.transform?.y ?? 0;
      const isVertical = settings.height > settings.width;
      const previewWidth = isVertical ? 400 : 900;
      const previewHeight = isVertical ? 711 : 506;
      const scaleFactorX = settings.width / previewWidth;
      const scaleFactorY = settings.height / previewHeight;
      const scaledXOffset = Math.round(xOffset * scaleFactorX);
      const scaledYOffset = Math.round(yOffset * scaleFactorY);

      const overlayX = `(W-w)/2+${scaledXOffset}`;
      const overlayY = `H*0.85-h/2+${scaledYOffset}`;

      console.log(`[${sessionId}] Overlay ${clip.trackId} position: xOffset=${xOffset}, yOffset=${yOffset}, preview=${previewWidth}x${previewHeight}`);
      console.log(`[${sessionId}]   -> scaled=(${scaledXOffset}, ${scaledYOffset}), FFmpeg: x=${overlayX}, y=${overlayY}`);

      const enable = `between(t,${clip.start},${clip.start + trimDuration})`;
      filterParts.push(`[${lastVideo}][v${idx}]overlay=x=${overlayX}:y=${overlayY}:enable='${enable}'[out${idx}]`);
      lastVideo = `out${idx}`;
    }

    // Process frame template overlays (logos, text, video overlays)
    if (frameTemplate && frameTemplate.overlays && frameTemplate.overlays.length > 0) {
      let overlayIdx = 0;
      for (const overlay of frameTemplate.overlays) {
        const startTime = overlay.startTime ?? 0;
        const endTime = overlay.endTime ?? totalDuration;
        const enable = `between(t,${startTime},${endTime})`;

        // Calculate position based on zone (top 20% or bottom 20% of frame)
        // Zone height is 20% of frame, video is in middle 60%
        const zoneHeight = settings.height * 0.2;
        const zoneTop = overlay.zone === 'top' ? 0 : settings.height * 0.8;
        // X is 0-100% of width, Y is 0-100% within zone
        const xPos = Math.round(settings.width * (overlay.x / 100));
        const yPos = Math.round(zoneTop + zoneHeight * (overlay.y / 100));

        if (overlay.type === 'logo' && overlay.assetId) {
          // Find the overlay asset - check overlayAssets array first, then session.assets
          let assetPath = null;
          const overlayAsset = overlayAssets.find(a => a.id === overlay.assetId);
          console.log(`[${sessionId}] Looking for logo asset: ${overlay.assetId}`);
          console.log(`[${sessionId}]   overlayAsset found: ${!!overlayAsset}, has dataUrl: ${!!(overlayAsset && overlayAsset.dataUrl)}`);
          console.log(`[${sessionId}]   session.assets exists: ${!!session.assets}, has assetId: ${session.assets ? session.assets.has(overlay.assetId) : false}`);
          if (session.assets) {
            console.log(`[${sessionId}]   session.assets keys: ${Array.from(session.assets.keys()).join(', ')}`);
          }

          if (overlayAsset && overlayAsset.dataUrl) {
            // Client sent base64 data
            assetPath = writeBase64ToTempFile(overlayAsset.dataUrl, `logo_${overlayIdx}.png`);
          } else if (session.assets && session.assets.has(overlay.assetId)) {
            // Look up from session assets (server-side storage)
            const sessionAsset = session.assets.get(overlay.assetId);
            console.log(`[${sessionId}]   sessionAsset: ${JSON.stringify(sessionAsset)}`);
            if (sessionAsset && sessionAsset.path && existsSync(sessionAsset.path)) {
              assetPath = sessionAsset.path;
              console.log(`[${sessionId}] Using session asset for logo: ${assetPath}`);
            } else {
              console.log(`[${sessionId}]   sessionAsset path missing or doesn't exist: ${sessionAsset?.path}`);
            }
          }

          if (assetPath) {
            // Handle different image types
            const isGif = /\.gif$/i.test(assetPath);
            if (isGif) {
              // GIFs need ignore_loop to loop indefinitely
              inputs.push('-ignore_loop', '0', '-i', assetPath);
            } else {
              // Regular images (PNG, JPG) need -loop 1
              inputs.push('-loop', '1', '-i', assetPath);
            }
            const logoIdx = inputIndex++;
            const scale = overlay.scale || 0.3;
            const logoWidth = Math.round(settings.width * scale);

            // Scale logo and overlay with timing
            filterParts.push(`[${logoIdx}:v]scale=${logoWidth}:-1[logo${overlayIdx}]`);
            filterParts.push(`[${lastVideo}][logo${overlayIdx}]overlay=x=${xPos}-w/2:y=${yPos}-h/2:enable='${enable}'[logoout${overlayIdx}]`);
            lastVideo = `logoout${overlayIdx}`;
            overlayIdx++;
          } else {
            console.log(`[${sessionId}] Logo asset not found: ${overlay.assetId}`);
          }
        } else if (overlay.type === 'text' && overlay.text) {
          // Use drawtext filter for text overlays
          const text = overlay.text.replace(/'/g, "\\'").replace(/:/g, "\\:");
          const fontSize = overlay.fontSize || 32;
          const fontColor = (overlay.color || '#ffffff').replace('#', '');
          const fontFamily = overlay.fontFamily || 'Arial';

          filterParts.push(`[${lastVideo}]drawtext=text='${text}':fontsize=${fontSize}:fontcolor=0x${fontColor}:fontfile=/Windows/Fonts/arial.ttf:x=${xPos}-tw/2:y=${yPos}-th/2:enable='${enable}'[textout${overlayIdx}]`);
          lastVideo = `textout${overlayIdx}`;
          overlayIdx++;
        } else if (overlay.type === 'video' && overlay.assetId) {
          // Find the video overlay asset - check overlayAssets array first, then session.assets
          let assetPath = null;
          const overlayAsset = overlayAssets.find(a => a.id === overlay.assetId);

          if (overlayAsset && overlayAsset.dataUrl) {
            // Client sent base64 data
            assetPath = writeBase64ToTempFile(overlayAsset.dataUrl, `vidoverlay_${overlayIdx}.mp4`);
          } else if (session.assets && session.assets.has(overlay.assetId)) {
            // Look up from session assets (server-side storage)
            const sessionAsset = session.assets.get(overlay.assetId);
            if (sessionAsset && sessionAsset.path && existsSync(sessionAsset.path)) {
              assetPath = sessionAsset.path;
              console.log(`[${sessionId}] Using session asset for video overlay: ${assetPath}`);
            }
          }

          if (assetPath) {
            // For looping video overlays
            if (overlay.loop) {
              inputs.push('-stream_loop', '-1', '-i', assetPath);
            } else {
              inputs.push('-i', assetPath);
            }
            const vidIdx = inputIndex++;
            const scale = overlay.scale || 0.4;
            const vidWidth = Math.round(settings.width * scale);

            // Scale video overlay and composite with timing
            filterParts.push(`[${vidIdx}:v]scale=${vidWidth}:-1,setpts=PTS-STARTPTS[vidov${overlayIdx}]`);
            filterParts.push(`[${lastVideo}][vidov${overlayIdx}]overlay=x=${xPos}-w/2:y=${yPos}-h/2:enable='${enable}'[vidovout${overlayIdx}]`);
            lastVideo = `vidovout${overlayIdx}`;
            overlayIdx++;
          } else {
            console.log(`[${sessionId}] Video overlay asset not found: ${overlay.assetId}`);
          }
        }
      }
    }

    // ===== RENDER CAPTIONS (T1 track) =====
    // Get caption clips from T1 and render them as drawtext overlays
    // FrameForge styles (highlight, bold-center, minimal) get rendered as video overlays
    const captionClips = clips.filter(c => c.trackId === 'T1');
    const captionData = session.project.captionData || {};

    // Check if any captions use FrameForge styles
    const FRAMEFORGE_CAPTION_STYLES = ['highlight', 'bold-center', 'minimal'];
    const frameforgeCapLocs = [
      join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'workspace', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
      join(process.cwd(), '..', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
    ];
    const ffCapCliPath = frameforgeCapLocs.find(p => existsSync(p));

    if (captionClips.length > 0) {
      console.log(`[${sessionId}] Rendering ${captionClips.length} caption clips`);
      renderDebugLines.push(`\nCaption clips: ${captionClips.length}`);

      let captionIdx = 0;
      for (const captionClip of captionClips) {
        const clipCaptionData = captionData[captionClip.id];
        if (!clipCaptionData || !clipCaptionData.words || clipCaptionData.words.length === 0) {
          renderDebugLines.push(`  Skipping caption clip ${captionClip.id} - no words`);
          continue;
        }

        const style = clipCaptionData.style || {};
        const words = clipCaptionData.words;
        const timeOffset = style.timeOffset || 0;

        // Style settings with defaults
        // Scale font size for output resolution - preview uses ~300px width, output is 1080px
        // So we scale the fontSize by roughly 3x to maintain visual proportions
        const baseFontSize = style.fontSize || 48;
        const scaleFactor = settings.width / 360; // Approximate preview width
        const fontSize = Math.round(baseFontSize * scaleFactor);

        const fontColor = (style.color || '#ffffff').replace('#', '');
        const strokeColor = (style.strokeColor || '#000000').replace('#', '');
        // Scale stroke width proportionally
        const baseStrokeWidth = style.strokeWidth || 3;
        const strokeWidth = Math.round(baseStrokeWidth * scaleFactor);
        const fontWeight = style.fontWeight || 'bold';
        const position = style.position || 'bottom';
        const animation = style.animation || 'none';
        const highlightColor = (style.highlightColor || '#FFD700').replace('#', '');

        console.log(`[${sessionId}] Caption style: fontSize=${fontSize} (base ${baseFontSize}, scale ${scaleFactor.toFixed(2)}), color=#${fontColor}, animation=${animation}`);

        // Calculate Y position based on style.position
        let yExpr;
        if (position === 'top') {
          yExpr = `h*0.15`;
        } else if (position === 'center') {
          yExpr = `(h-th)/2`;
        } else {
          // bottom - position in lower 20% for 9:16
          yExpr = `h*0.80`;
        }

        // Font path (Windows)
        const fontPath = fontWeight === 'black'
          ? '/Windows/Fonts/arialbd.ttf'
          : fontWeight === 'bold'
            ? '/Windows/Fonts/arialbd.ttf'
            : '/Windows/Fonts/arial.ttf';

        renderDebugLines.push(`  Caption clip ${captionClip.id}: ${words.length} words, style=${JSON.stringify(style)}`);

        // FrameForge caption rendering for enhanced styles
        if (FRAMEFORGE_CAPTION_STYLES.includes(animation) && ffCapCliPath) {
          console.log(`[${sessionId}] Rendering FrameForge captions (${animation} style)...`);

          // Build word groups (2-4 words per group)
          const groups = [];
          let currentGroup = [];
          for (let wi = 0; wi < words.length; wi++) {
            currentGroup.push(words[wi]);
            const isLast = wi === words.length - 1;
            const nextWord = isLast ? null : words[wi + 1];
            let shouldBreak = currentGroup.length >= 4 || isLast;
            if (nextWord && nextWord.start - words[wi].end > 0.3) shouldBreak = true;
            if (/[.,!?;:]$/.test(words[wi].text)) shouldBreak = true;
            if (shouldBreak && currentGroup.length > 0) {
              groups.push({
                words: currentGroup.map(w => ({ text: w.text, startMs: Math.round((captionClip.start + w.start + timeOffset) * 1000), endMs: Math.round((captionClip.start + w.end + timeOffset) * 1000) })),
                startMs: Math.round((captionClip.start + currentGroup[0].start + timeOffset) * 1000),
                endMs: Math.round((captionClip.start + currentGroup[currentGroup.length - 1].end + timeOffset) * 1000),
                text: currentGroup.map(w => w.text).join(' '),
              });
              currentGroup = [];
            }
          }

          const hlColor = style.highlightColor || '#FFD700';
          const txtColor = style.color || '#ffffff';
          const capFontSize = Math.round((style.fontSize || 24) * (settings.width / 360));

          // Position
          let capY = 'bottom: 8%';
          if (position === 'top') capY = 'top: 8%';
          else if (position === 'center') capY = 'top: 50%; transform: translate(-50%, -50%)';

          // Build animation logic per style
          let wordStyleFn = '';
          if (animation === 'highlight') {
            wordStyleFn = `
              var isActive = t >= w.startMs && t < w.endMs;
              el.style.padding = '2px 6px';
              el.style.margin = '0 3px';
              el.style.borderRadius = '4px';
              el.style.display = 'inline-block';
              el.style.backgroundColor = isActive ? '${hlColor}' : 'transparent';
              el.style.color = isActive ? '#000' : '${txtColor}';
              el.style.transform = isActive ? 'scale(1.12)' : 'scale(1)';
              el.style.transition = 'all 0.12s ease';`;
          } else if (animation === 'bold-center') {
            wordStyleFn = `
              var isActive = t >= w.startMs && t < w.endMs;
              var hasStarted = t >= w.startMs;
              el.style.display = 'inline-block';
              el.style.textTransform = 'uppercase';
              el.style.letterSpacing = '2px';
              el.style.margin = '0 6px';
              el.style.transform = isActive ? 'scale(1.5)' : hasStarted ? 'scale(1.1)' : 'scale(0.8)';
              el.style.opacity = hasStarted ? '1' : '0';
              el.style.color = isActive ? '${hlColor}' : '${txtColor}';
              el.style.transition = 'all 0.15s ease';`;
          } else { // minimal
            wordStyleFn = `
              var hasStarted = t >= w.startMs;
              el.style.display = 'inline-block';
              el.style.margin = '0 4px';
              el.style.opacity = hasStarted ? '1' : '0';
              el.style.transition = 'all 0.25s ease-out';`;
          }

          const captionHtml = `<!DOCTYPE html>
<html><head><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${settings.width}px;height:${settings.height}px;overflow:hidden;background:#00ff00;font-family:'Inter',system-ui,sans-serif}
#cap{position:absolute;left:50%;${capY.includes('translate') ? capY : capY};${capY.includes('translate') ? '' : 'transform:translateX(-50%)'};text-align:center;width:90%;z-index:9999;pointer-events:none}
.grp{display:none;background:${animation === 'highlight' ? 'rgba(0,0,0,0.85)' : 'transparent'};padding:${animation === 'highlight' ? '12px 24px' : '8px'};border-radius:12px;${animation === 'highlight' ? 'backdrop-filter:blur(8px);' : ''}}
.grp.active{display:inline-block}
.w{font-size:${capFontSize}px;font-weight:900;color:${txtColor};line-height:1.3}
</style></head><body>
<div id="cap"></div>
<script>
var groups=${JSON.stringify(groups)};
var cap=document.getElementById('cap');
groups.forEach(function(g,gi){
  var div=document.createElement('div');div.className='grp';div.id='g'+gi;
  g.words.forEach(function(w){
    var s=document.createElement('span');s.className='w';s.textContent=w.text;s.dataset.s=w.startMs;s.dataset.e=w.endMs;
    div.appendChild(s);
  });
  cap.appendChild(div);
});
function update(){
  var t=performance.now();
  groups.forEach(function(g,gi){
    var el=document.getElementById('g'+gi);
    if(t>=g.startMs&&t<=g.endMs+150){el.classList.add('active')}else{el.classList.remove('active')}
    if(el.classList.contains('active')){
      var spans=el.querySelectorAll('.w');
      for(var si=0;si<spans.length;si++){
        var w={startMs:parseInt(spans[si].dataset.s),endMs:parseInt(spans[si].dataset.e)};
        var el2=spans[si];
        ${wordStyleFn}
      }
    }
  });
  requestAnimationFrame(update);
}
requestAnimationFrame(update);
</script></body></html>`;

          const capHtmlPath = join(session.dir, `caption_overlay_${captionClip.id}.html`);
          const capVideoPath = join(session.dir, `caption_overlay_${captionClip.id}.mp4`);
          writeFileSync(capHtmlPath, captionHtml);

          // Render caption overlay with FrameForge
          try {
            const capDuration = Math.ceil(totalDuration);
            const { execSync: execSyncLocal } = await import('child_process');
            execSyncLocal(`node "${ffCapCliPath}" render "${capHtmlPath}" --output "${capVideoPath}" --duration ${capDuration} --width ${settings.width} --height ${settings.height}`, {
              stdio: 'pipe',
              env: { ...process.env },
              timeout: 300000,
            });

            // Add as input and overlay with chroma key
            inputs.push('-i', capVideoPath);
            const capInputIdx = inputIndex++;
            filterParts.push(`[${capInputIdx}:v]colorkey=0x00ff00:0.3:0.2[ffcap${captionClip.id}]`);
            filterParts.push(`[${lastVideo}][ffcap${captionClip.id}]overlay=0:0:shortest=1[ffcapout${captionClip.id}]`);
            lastVideo = `ffcapout${captionClip.id}`;

            console.log(`[${sessionId}] FrameForge caption overlay rendered (${capDuration}s)`);
          } catch (ffCapErr) {
            console.error(`[${sessionId}] FrameForge caption render failed, falling back to drawtext:`, ffCapErr.message?.substring(0, 200));
            // Fall through to drawtext below
          }

          try { unlinkSync(capHtmlPath); } catch (e) {}
          // Skip drawtext for this clip if FrameForge succeeded
          if (existsSync(capVideoPath)) continue;
        }

        // Group words into phrases (max 5 words or ~30 chars per phrase for readability)
        const phrases = [];
        let currentPhrase = [];
        let currentLength = 0;
        const MAX_WORDS = 5;
        const MAX_CHARS = 30;

        for (const word of words) {
          if (currentPhrase.length >= MAX_WORDS ||
              (currentLength + word.text.length > MAX_CHARS && currentPhrase.length > 0)) {
            // Start new phrase
            if (currentPhrase.length > 0) {
              phrases.push([...currentPhrase]);
            }
            currentPhrase = [word];
            currentLength = word.text.length;
          } else {
            currentPhrase.push(word);
            currentLength += word.text.length + 1; // +1 for space
          }
        }
        if (currentPhrase.length > 0) {
          phrases.push(currentPhrase);
        }

        renderDebugLines.push(`  Grouped into ${phrases.length} phrases`);

        // Render each phrase as a single drawtext
        for (const phrase of phrases) {
          const phraseText = phrase.map(w => w.text).join(' ');
          const phraseStart = captionClip.start + phrase[0].start + timeOffset;
          const phraseEnd = captionClip.start + phrase[phrase.length - 1].end + timeOffset;

          // Escape special characters for FFmpeg drawtext
          // Replace apostrophes/quotes with unicode equivalents to avoid shell escaping issues
          const escapedText = phraseText
            .replace(/\\/g, '')           // Remove backslashes
            .replace(/'/g, '\u2019')      // Replace ' with unicode right single quote '
            .replace(/"/g, '\u201D')      // Replace " with unicode right double quote "
            .replace(/:/g, '\\:')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/%/g, '%%')          // Percent needs doubling in drawtext
            .replace(/;/g, '\\;');        // Semicolon needs escaping

          const enable = `between(t,${phraseStart.toFixed(3)},${phraseEnd.toFixed(3)})`;

          // Use highlight color for karaoke animation, otherwise use regular font color
          const textColor = animation === 'karaoke' ? highlightColor : fontColor;

          // Build drawtext filter
          // Center horizontally, position vertically based on style
          const drawtextFilter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=0x${textColor}:fontfile='${fontPath}':x=(w-text_w)/2:y=${yExpr}:borderw=${strokeWidth}:bordercolor=0x${strokeColor}:enable='${enable}'`;

          filterParts.push(`[${lastVideo}]${drawtextFilter}[cap${captionIdx}]`);
          lastVideo = `cap${captionIdx}`;
          captionIdx++;
        }
      }

      console.log(`[${sessionId}] Added ${captionIdx} caption phrase filters`);
      renderDebugLines.push(`Added ${captionIdx} caption phrase filters`);
    }

    // Rename final output
    filterParts.push(`[${lastVideo}]copy[vout]`);

    // Audio mixing — collect audio from:
    // 1. Video clips on V1/V2/V3 that have embedded audio (skip images & AI animations)
    // 2. Dedicated audio clips on A1/A2
    const audioLabels = [];

    for (const { clip, asset, idx } of videoInputIndices) {
      // Only extract audio from real video files (not images, not AI-generated Remotion renders)
      if (asset.type !== 'video' || asset.aiGenerated) continue;
      const inPoint = clip.inPoint || 0;
      const outPoint = clip.outPoint || asset.duration;
      const delayMs = Math.floor(clip.start * 1000);
      filterParts.push(`[${idx}:a]atrim=${inPoint}:${outPoint},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[va${idx}]`);
      audioLabels.push(`[va${idx}]`);
    }

    for (const clip of audioClips) {
      const asset = session.assets.get(clip.assetId);
      if (!asset) continue;
      inputs.push('-i', asset.path);
      const idx = inputIndex++;
      const inPoint = clip.inPoint || 0;
      const outPoint = clip.outPoint || asset.duration;
      const delayMs = Math.floor(clip.start * 1000);
      filterParts.push(`[${idx}:a]atrim=${inPoint}:${outPoint},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[aa${idx}]`);
      audioLabels.push(`[aa${idx}]`);
    }

    if (audioLabels.length === 1) {
      filterParts.push(`${audioLabels[0]}acopy[aout]`);
    } else if (audioLabels.length > 1) {
      filterParts.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0[aout]`);
    }

    // Build final command
    const outputPath = join(session.rendersDir, isPreview ? 'preview.mp4' : `export-${Date.now()}.mp4`);

    // Write filter_complex to a file to avoid command line length limits (ENAMETOOLONG)
    const filterContent = filterParts.join(';');
    const filterScriptPath = join(session.dir, 'filter_complex.txt');
    writeFileSync(filterScriptPath, filterContent);
    console.log(`[${sessionId}] Filter script written to: ${filterScriptPath} (${filterContent.length} chars)`);

    const ffmpegArgs = [
      '-y',
      ...inputs,
      '-filter_complex_script', filterScriptPath,
      '-map', '[vout]',
    ];

    if (audioLabels.length > 0) {
      ffmpegArgs.push('-map', '[aout]');
    }

    // Encoding settings
    if (isPreview) {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28');
    } else {
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
    }

    ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
    ffmpegArgs.push('-movflags', '+faststart');
    ffmpegArgs.push('-t', totalDuration.toString());
    ffmpegArgs.push(outputPath);

    renderDebugLines.push(`\nFFmpeg command:\nffmpeg ${ffmpegArgs.join(' ')}`);
    const renderLogPath = join(session.dir, 'render-debug.log');
    writeFileSync(renderLogPath, renderDebugLines.join('\n'));
    console.log(`[${sessionId}] FFmpeg render command prepared — debug log: ${renderLogPath}`);
    console.log(`[${sessionId}] Full ffmpeg args: ffmpeg ${ffmpegArgs.join(' ')}`);

    await runFFmpeg(ffmpegArgs, sessionId);

    const { stat } = await import('fs/promises');
    const outputStats = await stat(outputPath);

    console.log(`[${sessionId}] Render complete: ${(outputStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[${sessionId}] === RENDER COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      path: outputPath,
      size: outputStats.size,
      duration: totalDuration,
      downloadUrl: `/session/${sessionId}/renders/${isPreview ? 'preview' : 'export'}`,
    }));

  } catch (error) {
    console.error(`[${sessionId}] Render error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Download rendered video
async function handleRenderDownload(req, res, sessionId, renderType) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  // Find the render file
  const files = readdirSync(session.rendersDir);

  let renderFile;
  let downloadFilename;

  if (renderType === 'preview') {
    renderFile = files.find(f => f === 'preview.mp4');
    downloadFilename = 'preview.mp4';
  } else if (renderType === 'export') {
    // Get most recent export
    renderFile = files
      .filter(f => f.startsWith('export-'))
      .sort()
      .pop();
    downloadFilename = `${session.originalName.replace(/\.[^.]+$/, '')}-export.mp4`;
  } else {
    // Check if renderType is a specific filename (for scene exports)
    if (files.includes(renderType)) {
      renderFile = renderType;
      downloadFilename = renderType;
    }
  }

  if (!renderFile) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Render not found' }));
    return;
  }

  const renderPath = join(session.rendersDir, renderFile);
  const { stat } = await import('fs/promises');
  const stats = await stat(renderPath);

  const filename = downloadFilename;

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
  });

  createReadStream(renderPath).pipe(res);
}

// Create animated GIF from an image
async function handleCreateGif(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const {
      sourceAssetId,
      effect = 'pulse', // pulse, zoom, rotate, bounce, fade
      duration = 2,      // seconds
      fps = 15,
      width = 400,
      height = 400,
    } = options;

    const sourceAsset = session.assets.get(sourceAssetId);
    if (!sourceAsset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Source asset not found' }));
      return;
    }

    if (sourceAsset.type !== 'image') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Source must be an image' }));
      return;
    }

    const jobId = randomUUID();
    console.log(`\n[${jobId}] === CREATE ANIMATED GIF ===`);
    console.log(`[${jobId}] Source: ${sourceAsset.filename}, Effect: ${effect}, Duration: ${duration}s`);

    // Generate GIF output path
    const gifId = randomUUID();
    const gifPath = join(session.assetsDir, `${gifId}.gif`);
    const thumbPath = join(session.assetsDir, `${gifId}_thumb.jpg`);

    // Build FFmpeg filter based on effect
    let filter;
    const totalFrames = duration * fps;

    switch (effect) {
      case 'pulse':
        // Pulsing scale effect (breathe in/out)
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `zoompan=z='1+0.1*sin(on*PI*2/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
        break;

      case 'zoom':
        // Ken Burns zoom in effect
        filter = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=decrease,` +
          `zoompan=z='min(zoom+0.002,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
        break;

      case 'rotate':
        // Gentle rotation effect
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `rotate=t*PI/8:c=none:ow=${width}:oh=${height},fps=${fps}`;
        break;

      case 'bounce':
        // Bouncing effect (up and down)
        filter = `scale=${width}:${height - 40}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:'(oh-ih)/2+20*sin(t*PI*2)':color=transparent,fps=${fps}`;
        break;

      case 'fade':
        // Fade in and out
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `fade=t=in:st=0:d=${duration / 4},fade=t=out:st=${duration * 3 / 4}:d=${duration / 4},fps=${fps}`;
        break;

      case 'shake':
        // Shake/vibrate effect
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width + 20}:${height + 20}:(ow-iw)/2:(oh-ih)/2,` +
          `crop=${width}:${height}:'10+5*sin(t*30)':'10+5*cos(t*25)',fps=${fps}`;
        break;

      default:
        // Simple loop with no animation
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`;
    }

    // FFmpeg command to create animated GIF
    const ffmpegArgs = [
      '-y',
      '-loop', '1',
      '-i', sourceAsset.path,
      '-t', duration.toString(),
      '-vf', filter,
      '-gifflags', '+transdiff',
      gifPath
    ];

    console.log(`[${jobId}] Running FFmpeg...`);
    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail from first frame
    try {
      await runFFmpeg([
        '-y',
        '-i', gifPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    const { stat } = await import('fs/promises');
    const stats = await stat(gifPath);

    // Create asset entry
    const gifAsset = {
      id: gifId,
      type: 'image',
      filename: `${sourceAsset.filename.replace(/\.[^.]+$/, '')}-${effect}.gif`,
      path: gifPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: duration, // GIFs have duration
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
    };

    session.assets.set(gifId, gifAsset);

    console.log(`[${jobId}] GIF created: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`[${jobId}] === GIF CREATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      asset: {
        id: gifAsset.id,
        type: gifAsset.type,
        filename: gifAsset.filename,
        duration: gifAsset.duration,
        size: gifAsset.size,
        width: gifAsset.width,
        height: gifAsset.height,
        thumbnailUrl: gifAsset.thumbPath ? `/session/${sessionId}/assets/${gifId}/thumbnail` : null,
      },
    }));

  } catch (error) {
    console.error(`[${sessionId}] GIF creation error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== TRANSCRIPTION & KEYWORD EXTRACTION ==============

// Known keywords/brands to detect in transcripts
const KNOWN_KEYWORDS = [
  // Tech companies
  'anthropic', 'claude', 'openai', 'chatgpt', 'gpt', 'google', 'gemini', 'bard',
  'microsoft', 'copilot', 'meta', 'llama', 'apple', 'siri', 'amazon', 'alexa',
  'nvidia', 'tesla', 'spacex', 'neuralink', 'twitter', 'x',
  // Social media
  'youtube', 'tiktok', 'instagram', 'facebook', 'snapchat', 'linkedin', 'reddit',
  'discord', 'twitch', 'spotify',
  // People
  'elon musk', 'sam altman', 'mark zuckerberg', 'sundar pichai', 'satya nadella',
  'tim cook', 'jensen huang', 'dario amodei', 'trump', 'biden',
  // General tech terms
  'artificial intelligence', 'machine learning', 'neural network', 'blockchain',
  'cryptocurrency', 'bitcoin', 'ethereum', 'nft', 'metaverse', 'virtual reality',
  'augmented reality', 'robotics', 'automation',
  // Products
  'iphone', 'android', 'windows', 'macbook', 'playstation', 'xbox', 'nintendo',
  'airpods', 'vision pro',
];

// Extract keywords from transcript with timestamps
function extractKeywordsFromTranscript(transcript, words) {
  const foundKeywords = [];
  const lowerTranscript = transcript.toLowerCase();

  for (const keyword of KNOWN_KEYWORDS) {
    const lowerKeyword = keyword.toLowerCase();
    let searchIndex = 0;

    while (true) {
      const index = lowerTranscript.indexOf(lowerKeyword, searchIndex);
      if (index === -1) break;

      // Find the timestamp for this occurrence
      // We need to count characters to find which word this belongs to
      let charCount = 0;
      let timestamp = 0;
      let confidence = 0.9;

      for (const word of words) {
        const wordEnd = charCount + word.word.length + 1; // +1 for space
        if (index >= charCount && index < wordEnd) {
          timestamp = word.start;
          confidence = word.confidence || 0.9;
          break;
        }
        charCount = wordEnd;
      }

      // Avoid duplicates within 5 seconds
      const isDuplicate = foundKeywords.some(
        k => k.keyword === keyword && Math.abs(k.timestamp - timestamp) < 5
      );

      if (!isDuplicate) {
        foundKeywords.push({
          keyword,
          timestamp,
          confidence,
        });
      }

      searchIndex = index + keyword.length;
    }
  }

  // Sort by timestamp
  foundKeywords.sort((a, b) => a.timestamp - b.timestamp);

  return foundKeywords;
}

// Transcribe video using OpenAI Whisper API
async function transcribeVideo(videoPath, jobId) {
  const audioPath = join(TEMP_DIR, `${jobId}-audio-whisper.mp3`);

  try {
    // Extract audio
    console.log(`[${jobId}] Extracting audio for transcription...`);
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    console.log(`\n[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Check for OpenAI API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured in .dev.vars');
    }

    // Send to Whisper API
    console.log(`[${jobId}] Sending to Whisper API...`);
    const audioBuffer = readFileSync(audioPath);
    const formData = new globalThis.FormData();
    formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`[${jobId}] Transcription complete: ${result.text?.length || 0} characters`);

    // Cleanup
    try { unlinkSync(audioPath); } catch {}

    return {
      text: result.text || '',
      words: result.words || [],
      duration: result.duration || 0,
    };

  } catch (error) {
    try { unlinkSync(audioPath); } catch {}
    throw error;
  }
}

// Search GIPHY for a keyword
async function searchGiphy(keyword, limit = 1) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GIPHY_API_KEY_HERE') {
    throw new Error('GIPHY_API_KEY not configured. Get a free key at https://developers.giphy.com/');
  }

  const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(keyword)}&limit=${limit}&rating=g&lang=en`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data || [];
}

// Download GIF and save as asset
async function downloadGifAsAsset(session, gifUrl, keyword, timestamp) {
  const jobId = randomUUID();
  const gifId = randomUUID();
  const gifPath = join(session.assetsDir, `${gifId}.gif`);
  const thumbPath = join(session.assetsDir, `${gifId}_thumb.jpg`);

  try {
    console.log(`[${jobId}] Downloading GIF for "${keyword}"...`);

    const response = await fetch(gifUrl);
    if (!response.ok) {
      throw new Error(`Failed to download GIF: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    writeFileSync(gifPath, Buffer.from(buffer));

    // Generate thumbnail
    try {
      await runFFmpeg([
        '-y', '-i', gifPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    const { stat } = await import('fs/promises');
    const stats = await stat(gifPath);

    // Get GIF dimensions
    const info = await getMediaInfo(gifPath);

    const asset = {
      id: gifId,
      type: 'image',
      filename: `${keyword.replace(/\s+/g, '-')}.gif`,
      path: gifPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: 3, // Default 3 seconds for GIFs
      size: stats.size,
      width: info.width || 200,
      height: info.height || 200,
      createdAt: Date.now(),
      // Extra metadata for auto-placement
      keyword,
      timestamp,
    };

    session.assets.set(gifId, asset);

    console.log(`[${jobId}] GIF saved: ${(stats.size / 1024).toFixed(1)} KB`);

    return asset;

  } catch (error) {
    try { unlinkSync(gifPath); } catch {}
    try { unlinkSync(thumbPath); } catch {}
    throw error;
  }
}

// Search GIPHY for trending GIFs
async function searchGiphyTrending(limit = 20) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GIPHY_API_KEY_HERE') {
    throw new Error('GIPHY_API_KEY not configured. Get a free key at https://developers.giphy.com/');
  }

  const url = `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&rating=g`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data || [];
}

// Handle GIPHY search endpoint
async function handleGiphySearch(req, res, sessionId, url) {
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const query = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (!query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Search query (q) is required' }));
      return;
    }

    const gifs = await searchGiphy(query, limit);

    // Format response
    const results = gifs.map(gif => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      previewUrl: gif.images.fixed_width.url,
      thumbnailUrl: gif.images.fixed_width_still?.url || gif.images.fixed_width.url,
      width: parseInt(gif.images.original.width, 10),
      height: parseInt(gif.images.original.height, 10),
      source: 'giphy',
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gifs: results }));
  } catch (error) {
    console.error('GIPHY search error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle GIPHY trending endpoint
async function handleGiphyTrending(req, res, sessionId, url) {
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const gifs = await searchGiphyTrending(limit);

    // Format response
    const results = gifs.map(gif => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      previewUrl: gif.images.fixed_width.url,
      thumbnailUrl: gif.images.fixed_width_still?.url || gif.images.fixed_width.url,
      width: parseInt(gif.images.original.width, 10),
      height: parseInt(gif.images.original.height, 10),
      source: 'giphy',
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gifs: results }));
  } catch (error) {
    console.error('GIPHY trending error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle adding a GIPHY GIF to assets
async function handleGiphyAdd(req, res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    // Parse request body
    const body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

    const { gifUrl, title } = body;
    if (!gifUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gifUrl is required' }));
      return;
    }

    // Download and add to assets
    const asset = await downloadGifAsAsset(session, gifUrl, title || 'GIF', Date.now());

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      asset: {
        id: asset.id,
        filename: asset.filename,
        type: asset.type,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${asset.id}/stream`,
      }
    }));
  } catch (error) {
    console.error('GIPHY add error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle simple transcription for captions using Gemini (returns word-level timestamps)
// Detect the correct Python binary (python3 on Linux/Mac, python on Windows)
async function getPythonBinary() {
  return new Promise((resolve) => {
    const check = spawn('python3', ['-c', 'print("ok")']);
    check.on('close', (code) => { if (code === 0) resolve('python3'); else resolve('python'); });
    check.on('error', () => resolve('python'));
  });
}

// Check if local Whisper is available
async function checkLocalWhisper() {
  const py = await getPythonBinary();
  return new Promise((resolve) => {
    const check = spawn(py, ['-c', 'import whisper; print("ok")']);
    let output = '';
    check.stdout.on('data', (data) => { output += data.toString(); });
    check.on('close', (code) => {
      resolve(code === 0 && output.includes('ok'));
    });
    check.on('error', () => resolve(false));
  });
}

// Run local Whisper transcription
async function runLocalWhisper(audioPath, jobId) {
  // Use path relative to this file, not cwd (which may be scripts/ folder)
  const scriptPath = join(import.meta.dirname, 'whisper-transcribe.py');
  const py = await getPythonBinary();

  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] Running local Whisper...`);
    const whisperProcess = spawn(py, [scriptPath, audioPath, 'base']);

    let stdout = '';
    let stderr = '';

    whisperProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    whisperProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress messages
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => console.log(`[${jobId}] Whisper: ${line}`));
    });

    whisperProcess.on('close', (code) => {
      if (code !== 0) {
        // Try to parse JSON error from stdout first
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(`Whisper error: ${result.error}`));
            return;
          }
        } catch (e) {
          // stdout wasn't valid JSON, fall through to stderr
        }
        reject(new Error(`Whisper failed (exit code ${code}): ${stderr.slice(-500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Failed to parse Whisper output: ${stdout.slice(0, 200)}`));
      }
    });

    whisperProcess.on('error', (err) => reject(err));
  });
}

// Cached transcription helper - avoids re-transcribing the same video
// Returns { text: string, words: Array<{text, start, end}> }
async function getOrTranscribeVideo(session, videoAsset, jobId) {
  // Check cache first
  if (session.transcriptCache.has(videoAsset.id)) {
    const cached = session.transcriptCache.get(videoAsset.id);
    console.log(`[${jobId}] Using cached transcript for ${videoAsset.filename} (cached ${Math.round((Date.now() - cached.cachedAt) / 1000)}s ago)`);
    return { text: cached.text, words: cached.words };
  }

  console.log(`[${jobId}] Transcribing ${videoAsset.filename}...`);

  // Check available transcription methods
  const hasLocalWhisper = await checkLocalWhisper();
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!hasLocalWhisper && !openaiKey && !geminiKey) {
    throw new Error('No transcription method available. Install local Whisper or set OPENAI_API_KEY/GEMINI_API_KEY');
  }

  // Extract audio from video
  const audioPath = join(TEMP_DIR, `${jobId}-transcript-audio.mp3`);
  await runFFmpeg([
    '-y', '-i', videoAsset.path,
    '-vn', '-acodec', 'libmp3lame', '-q:a', '4',
    audioPath
  ], jobId);

  let transcription = { text: '', words: [] };

  // Helper to transcribe with Gemini (always available as fallback if geminiKey exists)
  const transcribeWithGeminiLocal = async () => {
    if (!geminiKey) throw new Error('No transcription method available');
    console.log(`[${jobId}] Using Gemini for transcription...`);
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const audioBuffer = readFileSync(audioPath);
    const audioBase64 = audioBuffer.toString('base64');

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
          { text: `Transcribe this audio with word timestamps. Duration: ${videoAsset.duration}s. Return JSON: {"text": "full transcript", "words": [{"text": "word", "start": 0.0, "end": 0.5}]}` }
        ]
      }],
    });

    const respText = result.candidates[0].content.parts[0].text || '';
    try {
      return JSON.parse(respText);
    } catch {
      const match = respText.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : { text: respText, words: [] };
    }
  };

  if (hasLocalWhisper) {
    try {
      console.log(`[${jobId}] Using local Whisper...`);
      transcription = await runLocalWhisper(audioPath, jobId);
    } catch (whisperError) {
      console.log(`[${jobId}] Local Whisper failed: ${whisperError.message}`);
      console.log(`[${jobId}] Falling back to Gemini...`);
      transcription = await transcribeWithGeminiLocal();
    }
  } else if (openaiKey) {
    console.log(`[${jobId}] Using OpenAI Whisper API...`);
    const audioBuffer = readFileSync(audioPath);
    const formData = new globalThis.FormData();
    formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('language', 'en');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: formData,
    });

    if (!whisperResponse.ok) {
      throw new Error(`Whisper API error: ${whisperResponse.status}`);
    }

    const whisperResult = await whisperResponse.json();
    transcription = {
      text: whisperResult.text || '',
      words: (whisperResult.words || []).map(w => ({
        text: w.word,
        start: w.start,
        end: w.end,
      })),
    };
  } else if (geminiKey) {
    transcription = await transcribeWithGeminiLocal();
  }

  // Clean up audio file
  try { unlinkSync(audioPath); } catch {}

  // Cache the transcript
  session.transcriptCache.set(videoAsset.id, {
    text: transcription.text,
    words: transcription.words || [],
    cachedAt: Date.now(),
  });

  console.log(`[${jobId}] Transcription cached: ${transcription.text.substring(0, 100)}...`);
  return transcription;
}

// Get transcript segment for a specific time range
function getTranscriptSegment(transcription, startTime, endTime) {
  if (!transcription.words || transcription.words.length === 0) {
    return transcription.text;
  }

  const segmentWords = transcription.words.filter(w =>
    w.end >= startTime && w.start <= endTime
  );

  if (segmentWords.length === 0) {
    // Fall back to full transcript if no words in range
    return transcription.text;
  }

  return segmentWords.map(w => w.text).join(' ');
}

// Extract numeric value from stat strings like "$10K+", "50%", "2.5M", "10,000", etc.
// Returns { numericValue, prefix, suffix } where numericValue is the number to count TO
function extractNumericValue(valueStr) {
  if (!valueStr || typeof valueStr !== 'string') return null;

  const str = valueStr.trim();
  console.log(`[extractNumericValue] Input: "${str}"`);

  // Extract prefix (currency symbols and other leading non-numeric chars)
  let prefix = '';
  const prefixMatch = str.match(/^([£$€¥₹#@~]+)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
  }

  // Extract the number part (including decimals and commas)
  const numberMatch = str.match(/[\d,]+\.?\d*/);
  if (!numberMatch || numberMatch[0] === '') {
    console.log(`[extractNumericValue] No number found in "${str}"`);
    return null;
  }

  let numericValue = parseFloat(numberMatch[0].replace(/,/g, ''));
  if (isNaN(numericValue)) {
    console.log(`[extractNumericValue] Could not parse number from "${numberMatch[0]}"`);
    return null;
  }

  // Extract suffix - everything after the number
  let suffix = '';
  const numberEndIndex = str.indexOf(numberMatch[0]) + numberMatch[0].length;
  const afterNumber = str.substring(numberEndIndex).trim();
  console.log(`[extractNumericValue] Number: ${numericValue}, After: "${afterNumber}"`);

  // Check for multiplier suffixes and apply them
  if (/^k\b/i.test(afterNumber) || /^thousand/i.test(afterNumber)) {
    numericValue *= 1000;
    suffix = afterNumber.replace(/^k\b/i, '').replace(/^thousand/i, '').trim();
  } else if (/^m\b/i.test(afterNumber) || /^million/i.test(afterNumber)) {
    numericValue *= 1000000;
    suffix = afterNumber.replace(/^m\b/i, '').replace(/^million/i, '').trim();
  } else if (/^b\b/i.test(afterNumber) || /^billion/i.test(afterNumber)) {
    numericValue *= 1000000000;
    suffix = afterNumber.replace(/^b\b/i, '').replace(/^billion/i, '').trim();
  } else {
    suffix = afterNumber;
  }

  // Clean up suffix - keep only common suffix chars
  // But preserve % and + which are important
  if (suffix.includes('%')) {
    suffix = '%';
  } else if (suffix.includes('+')) {
    suffix = '+';
  } else {
    suffix = suffix.replace(/[^%+\-KMB]/gi, '').trim();
  }

  const result = {
    numericValue: Math.round(numericValue),
    prefix,
    suffix,
  };

  console.log(`[extractNumericValue] Result: ${JSON.stringify(result)}`);
  return result;
}

async function handleTranscribe(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);
  const audioPath = join(TEMP_DIR, `${jobId}-caption-audio.mp3`);

  try {
    // Check for transcription options in order of preference:
    // 1. Local Whisper (free, accurate)
    // 2. OpenAI Whisper API (paid, accurate)
    // 3. Gemini (paid, less accurate timestamps)
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!hasLocalWhisper && !openaiKey && !geminiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No transcription method available. Install local Whisper (pip3 install openai-whisper) or set GEMINI_API_KEY in .dev.vars' }));
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const { assetId, inPoint: inPointRaw, outPoint: outPointRaw } = JSON.parse(body || '{}');

    // Find the video asset
    let videoAsset = null;
    if (assetId) {
      videoAsset = session.assets.get(assetId);
    } else {
      // If no assetId, prefer the original (non-AI-generated) video asset
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated) {
          videoAsset = asset;
          break;
        }
      }
      // Fallback to any video if no non-AI video found
      if (!videoAsset) {
        for (const asset of session.assets.values()) {
          if (asset.type === 'video') {
            videoAsset = asset;
            break;
          }
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`[${jobId}] Transcribing: ${videoAsset.filename}`);

    // Get video duration
    const totalDuration = await getVideoDuration(videoAsset.path);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    // Resolve inPoint/outPoint.
    // Priority: 1) client-sent values  2) saved project V1 clip  3) in-memory asset duration
    // Do NOT use totalDuration (ffprobe) — container metadata can be stale after -c copy concat.
    const savedV1Clip = (session.project.clips || []).find(c => c.trackId === 'V1');
    const projectInPoint = savedV1Clip ? (savedV1Clip.inPoint ?? 0) : 0;
    // Compute outPoint from inPoint+duration (more reliable than reading outPoint directly)
    const projectOutPoint = savedV1Clip
      ? (savedV1Clip.inPoint ?? 0) + savedV1Clip.duration
      : (videoAsset.duration || totalDuration);

    const inPoint = typeof inPointRaw === 'number' ? inPointRaw : projectInPoint;
    const outPoint = typeof outPointRaw === 'number' ? outPointRaw : projectOutPoint;
    const segmentDuration = Math.max(outPoint - inPoint, 0.1);
    console.log(`[${jobId}] Transcribing segment [${inPoint.toFixed(2)}s – ${outPoint.toFixed(2)}s] = ${segmentDuration.toFixed(2)}s (file reports ${totalDuration.toFixed(2)}s, project clip duration=${savedV1Clip?.duration ?? 'N/A'})`);

    // Determine which method to use.
    // Local Whisper on CPU is impractical for videos > 2 minutes — prefer Gemini for long videos.
    const LOCAL_WHISPER_MAX_SECONDS = 120;
    const tooLongForLocalWhisper = segmentDuration > LOCAL_WHISPER_MAX_SECONDS;
    const useLocalWhisper = hasLocalWhisper && !tooLongForLocalWhisper;
    const useOpenAIWhisper = !useLocalWhisper && !!openaiKey;
    const useGemini = !useLocalWhisper && !openaiKey && !!geminiKey;

    const method = useLocalWhisper ? 'Local Whisper' : useOpenAIWhisper ? 'OpenAI Whisper' : 'Gemini';
    console.log(`\n[${jobId}] === TRANSCRIBE FOR CAPTIONS (${method}) ===`);

    if (useLocalWhisper) {
      console.log(`[${jobId}] Using local Whisper for accurate word-level timestamps (free)`);
    } else if (tooLongForLocalWhisper && hasLocalWhisper && !openaiKey) {
      console.log(`[${jobId}] Video is ${totalDuration.toFixed(0)}s — too long for local Whisper on CPU. Using Gemini instead.`);
    } else if (useOpenAIWhisper) {
      console.log(`[${jobId}] Using OpenAI Whisper API for accurate word-level timestamps`);
    } else {
      console.log(`[${jobId}] Using Gemini (timestamps may drift - install local Whisper for accurate sync)`);
    }

    // Extract audio as MP3 (only the segment that's actually on V1)
    // Always apply -ss and -t — this correctly handles both:
    //   • files where the container duration metadata is stale/wrong (e.g. after -c copy concat)
    //   • files where the clip only shows a trimmed portion of a longer asset
    console.log(`[${jobId}] Extracting audio...`);
    const extractArgs = ['-y'];
    if (inPoint > 0) extractArgs.push('-ss', inPoint.toString());
    extractArgs.push('-i', videoAsset.path, '-t', segmentDuration.toString());
    extractArgs.push('-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-ar', '16000', '-ac', '1', audioPath);
    await runFFmpeg(extractArgs, jobId);

    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    console.log(`[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Transcribe using the available method
    let transcription;

    if (useLocalWhisper) {
      // === Local Whisper - Free and accurate word-level timestamps ===
      try {
        transcription = await runLocalWhisper(audioPath, jobId);
        console.log(`[${jobId}] Local Whisper complete: ${transcription.words?.length || 0} words`);
      } catch (whisperError) {
        console.log(`[${jobId}] Local Whisper failed: ${whisperError.message}`);
        if (geminiKey) {
          console.log(`[${jobId}] Falling back to Gemini for transcription...`);
          // Fall through to Gemini transcription below by setting useGemini-like behavior
          const audioBuffer = readFileSync(audioPath);
          const audioBase64 = audioBuffer.toString('base64');
          const ai = new GoogleGenAI({ apiKey: geminiKey });

          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [
              { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
              { text: `Transcribe this audio with word-level timestamps. Duration: ${segmentDuration.toFixed(1)}s. Return JSON: {"text": "full text", "words": [{"text": "word", "start": 0.0, "end": 0.5}]}` }
            ]}]
          });

          const responseText = response.text || '';
          try {
            transcription = JSON.parse(responseText);
          } catch {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            transcription = jsonMatch ? JSON.parse(jsonMatch[0]) : { text: responseText, words: [] };
          }
        } else {
          throw whisperError;
        }
      }

    } else if (useOpenAIWhisper) {
      // === OpenAI Whisper API - Accurate word-level timestamps ===
      console.log(`[${jobId}] Sending to OpenAI Whisper for transcription...`);
      const audioBuffer = readFileSync(audioPath);

      // Create FormData for multipart upload (use native globals for Node 18+ fetch compatibility)
      const formData = new globalThis.FormData();
      formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');
      formData.append('language', 'en');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: formData,
      });

      if (!whisperResponse.ok) {
        const errorText = await whisperResponse.text();
        console.error(`[${jobId}] Whisper API error:`, errorText);
        throw new Error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
      }

      const whisperResult = await whisperResponse.json();
      console.log(`[${jobId}] Whisper transcription complete: ${whisperResult.words?.length || 0} words`);

      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map(w => ({
          text: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        }))
      };

    } else if (useGemini) {
      // === Gemini - Estimated timestamps (less accurate) ===
      console.log(`[${jobId}] Sending to Gemini for transcription...`);
      const audioBuffer = readFileSync(audioPath);
      const audioBase64 = audioBuffer.toString('base64');

      const ai = new GoogleGenAI({ apiKey: geminiKey });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mp3',
                  data: audioBase64
                }
              },
              {
                text: `Transcribe this audio with word-level timestamps. The audio is ${segmentDuration.toFixed(1)} seconds long.

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation. The response must be parseable JSON.

Return this exact JSON structure:
{
  "text": "full transcript text here",
  "words": [
    {"text": "word1", "start": 0.0, "end": 0.5},
    {"text": "word2", "start": 0.5, "end": 1.0}
  ]
}

Guidelines:
- Include every spoken word
- Timestamps should be in seconds (decimals allowed)
- "start" is when the word begins, "end" is when it ends
- Words should be in order
- Estimate timing based on natural speech patterns if exact timing is unclear
- Do not include filler sounds like "um" or "uh" unless they're clearly intentional`
              }
            ]
          }
        ]
      });

      const responseText = response.text || '';
      console.log(`[${jobId}] Gemini response length: ${responseText.length} chars`);
      console.log(`[${jobId}] Gemini raw response:`, responseText.substring(0, 1000));

      // Parse the JSON response
      try {
        // First try direct parse
        transcription = JSON.parse(responseText);
      } catch (e1) {
        try {
          // Try to extract JSON from markdown code blocks
          const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (codeBlockMatch) {
            transcription = JSON.parse(codeBlockMatch[1].trim());
          } else {
            // Try to extract any JSON object
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              transcription = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error('No JSON found in response');
            }
          }
        } catch (e2) {
          console.error(`[${jobId}] Failed to parse Gemini response:`, responseText);

          // Last resort: try to create a simple transcription from the text
          // If Gemini just returned plain text, use that as the transcript
          if (responseText && responseText.length > 10 && !responseText.startsWith('{')) {
            console.log(`[${jobId}] Falling back to plain text transcription`);
            const plainText = responseText.replace(/```[\s\S]*?```/g, '').trim();
            const wordsArray = plainText.split(/\s+/).filter(w => w.length > 0);
            const avgWordDuration = totalDuration / wordsArray.length;

            transcription = {
              text: plainText,
              words: wordsArray.map((word, i) => ({
                text: word.replace(/[.,!?;:'"]/g, ''),
                start: i * avgWordDuration,
                end: (i + 1) * avgWordDuration,
              }))
            };
          } else {
            throw new Error('Failed to parse transcription response from Gemini');
          }
        }
      }
    }

    // Cleanup
    try { unlinkSync(audioPath); } catch {}

    const words = (transcription.words || []).map(w => ({
      text: w.text || '',
      start: parseFloat(w.start) || 0,
      end: parseFloat(w.end) || 0,
    })).filter(w => w.text.trim().length > 0); // Filter out empty words

    console.log(`[${jobId}] Transcription complete: ${words.length} words`);
    console.log(`[${jobId}] Text: "${(transcription.text || '').substring(0, 200)}..."`);

    // Check if transcription is empty
    if (words.length === 0 && (!transcription.text || transcription.text.trim().length === 0)) {
      console.error(`[${jobId}] Empty transcription - Gemini returned no words`);
      console.error(`[${jobId}] This could mean: no speech in video, audio too quiet, or unsupported language`);

      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        error: 'No speech detected. Make sure the video has clear, audible speech.',
        debug: {
          transcriptionText: (transcription.text || '').substring(0, 200),
          wordCount: (transcription.words || []).length
        }
      }));
      return;
    }

    console.log(`[${jobId}] === TRANSCRIPTION DONE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      text: transcription.text || '',
      words: words,
      duration: totalDuration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { unlinkSync(audioPath); } catch {}
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle transcribe and extract keywords endpoint
async function handleTranscribeAndExtract(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    console.log(`\n[${jobId}] === TRANSCRIBE & EXTRACT KEYWORDS ===`);

    // Find the original (non-AI-generated) video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video') { videoAsset = asset; break; }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename}`);

    // Step 1: Transcribe
    const transcription = await transcribeVideo(videoAsset.path, jobId);
    console.log(`[${jobId}] Transcript: "${transcription.text.substring(0, 100)}..."`);

    // Step 2: Extract keywords
    const keywords = extractKeywordsFromTranscript(transcription.text, transcription.words);
    console.log(`[${jobId}] Found ${keywords.length} keywords`);

    // Step 3: Fetch GIFs from GIPHY for each keyword
    const gifAssets = [];
    for (const kw of keywords) {
      try {
        console.log(`[${jobId}] Searching GIPHY for "${kw.keyword}"...`);
        const gifs = await searchGiphy(kw.keyword, 1);

        if (gifs.length > 0) {
          // Get the fixed height small GIF URL
          const gifUrl = gifs[0].images?.fixed_height?.url ||
                         gifs[0].images?.original?.url;

          if (gifUrl) {
            const asset = await downloadGifAsAsset(session, gifUrl, kw.keyword, kw.timestamp);
            gifAssets.push({
              assetId: asset.id,
              keyword: kw.keyword,
              timestamp: kw.timestamp,
              confidence: kw.confidence,
              filename: asset.filename,
              thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
            });
          }
        }
      } catch (error) {
        console.warn(`[${jobId}] Failed to get GIF for "${kw.keyword}":`, error.message);
      }
    }

    console.log(`[${jobId}] Downloaded ${gifAssets.length} GIFs`);
    console.log(`[${jobId}] === TRANSCRIPTION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      transcript: transcription.text,
      keywords: keywords,
      gifAssets: gifAssets,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== B-ROLL IMAGE GENERATION ==============

// Helper to parse JSON body from request
async function parseBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// Analyze transcript for B-roll opportunities using Gemini
async function analyzeBrollOpportunities(transcript, words, totalDuration, apiKey) {
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [{
        text: `Analyze this video transcript and identify 3-5 key moments that would benefit from a visual B-roll image overlay. Consider:
- Products, technology, or brands mentioned (e.g., "iPhone", "AI assistant", "Tesla")
- Key concepts being explained that need visual reinforcement
- Metaphors or analogies that could be illustrated
- Emotional moments or reactions
- Statistics or data points that could use visual support

The video is ${totalDuration.toFixed(1)} seconds long.

Transcript: "${transcript}"

Word timings (for reference): ${JSON.stringify(words.slice(0, 50))}${words.length > 50 ? '...' : ''}

Return a JSON array with this exact structure:
[
  {
    "timestamp": 15.2,
    "prompt": "professional photograph of a sleek modern smartphone on a minimal desk setup, soft studio lighting, shallow depth of field, 4K quality",
    "reason": "product mention",
    "keyword": "iPhone"
  }
]

Guidelines for creating HIGH QUALITY image prompts:
- Write detailed, descriptive prompts (20-40 words)
- Request PHOTOREALISTIC or PROFESSIONAL PHOTOGRAPHY style
- Include lighting details: "soft studio lighting", "golden hour", "dramatic lighting"
- Include quality modifiers: "4K", "high resolution", "professional photograph", "cinematic"
- Describe composition: "shallow depth of field", "centered subject", "clean background"
- For tech: "sleek", "modern", "premium", "professional product shot"
- For concepts: "artistic visualization", "creative representation", "symbolic imagery"
- For people/emotions: "candid moment", "expressive", "authentic"
- AVOID: "icon", "minimalist", "flat design", "simple" - we want RICH, DETAILED images
- Images will be 1:1 square format

IMPORTANT: Return ONLY valid JSON array, no markdown, no explanation.`
      }]
    }],
    config: { responseMimeType: 'application/json' }
  });

  const responseText = response.text || '[]';

  try {
    // Try to parse directly
    const parsed = JSON.parse(responseText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to extract JSON from response
    const match = responseText.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return [];
      }
    }
    return [];
  }
}

// Generate image using fal.ai (Flux model)
async function generateImageWithGemini(prompt, apiKey, outputPath) {
  console.log(`    Generating image: "${prompt.substring(0, 50)}..."`);

  try {
    // Use fal.ai Flux for image generation (more reliable than Gemini)
    if (!process.env.FAL_KEY && !process.env.FAL_API_KEY) {
      console.error(`    ✗ FAL_API_KEY not configured for image generation`);
      return false;
    }

    // Use nano-banana-pro for higher quality results
    const result = await fal.run('fal-ai/nano-banana-pro', {
      input: {
        prompt: `${prompt}. Professional quality, high resolution, suitable for video production.`,
        num_images: 1,
        aspect_ratio: '1:1',
        resolution: '1K',
        output_format: 'png',
      },
    });

    // Debug: log the response structure
    console.log(`    fal.ai response keys: ${Object.keys(result || {}).join(', ')}`);

    // Try different response structures
    const images = result?.images || result?.data?.images || result?.output?.images || [];

    if (images.length > 0) {
      const imageUrl = images[0].url || images[0];
      console.log(`    Downloading from: ${imageUrl.substring(0, 50)}...`);

      // Download the image
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);
      writeFileSync(outputPath, imageBuffer);
      console.log(`    ✓ Image saved: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
      return true;
    }

    console.warn(`    ⚠️ No image in fal.ai response. Full response: ${JSON.stringify(result).substring(0, 300)}`);
    return false;
  } catch (error) {
    console.error(`    ✗ Image generation failed: ${error.message}`);
    return false;
  }
}

// Handle B-roll generation endpoint
async function handleSceneDetect(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    // Find video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated && existsSync(asset.path)) { videoAsset = asset; break; }
    }
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && existsSync(asset.path)) { videoAsset = asset; break; }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`\n[${jobId}] === SCENE DETECT ===`);
    console.log(`[${jobId}] Scanning: ${videoAsset.filename}`);

    // Run FFmpeg with select+showinfo to detect scene changes
    // select='gt(scene,0.3)' passes frames where scene change score > 0.3
    const stderr = await runFFmpeg([
      '-hide_banner',
      '-i', videoAsset.path,
      '-an',
      '-vf', "select='gt(scene,0.3)',showinfo",
      '-f', 'null', '-'
    ], jobId);

    // Parse showinfo output: "[Parsed_showinfo_1 @ ...] n: 2 pts: 75 pts_time:1.5000 ..."
    const scenes = [];
    const regex = /\[Parsed_showinfo[^\]]*\][^\n]*pts_time:([\d.]+)/g;
    let match;
    while ((match = regex.exec(stderr)) !== null) {
      const t = parseFloat(match[1]);
      if (t > 0.5) scenes.push({ timestamp: Math.round(t * 100) / 100 });
    }

    // Deduplicate: remove scenes within 1.5s of each other
    const deduped = scenes.filter((s, i) =>
      i === 0 || s.timestamp - scenes[i - 1].timestamp > 1.5
    );

    console.log(`[${jobId}] Detected ${deduped.length} scene changes`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, scenes: deduped, total: deduped.length }));

  } catch (error) {
    console.error(`[${jobId}] Scene detect error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Smart Scene Analysis (transcript + visual) ──────────────────────────────────
async function handleAnalyzeScenes(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { assetId, includeVisualDetection = true } = body;

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated && existsSync(asset.path)) {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`\n[${jobId}] === SMART SCENE ANALYSIS ===`);
    console.log(`[${jobId}] Analyzing: ${videoAsset.filename}`);

    // Step 1: Get transcript (use cache if available)
    let transcription = session.transcriptCache?.get(videoAsset.id);
    if (!transcription) {
      console.log(`[${jobId}] Transcribing video...`);
      transcription = await transcribeVideo(videoAsset.path, jobId);
      if (!session.transcriptCache) session.transcriptCache = new Map();
      session.transcriptCache.set(videoAsset.id, transcription);
    } else {
      console.log(`[${jobId}] Using cached transcript`);
    }

    if (!transcription || !transcription.words || transcription.words.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Could not transcribe video or transcript is empty' }));
      return;
    }

    // Step 2: Optional visual scene detection
    let visualScenes = [];
    if (includeVisualDetection) {
      console.log(`[${jobId}] Running visual scene detection...`);
      try {
        const stderr = await runFFmpeg([
          '-hide_banner', '-i', videoAsset.path, '-an',
          '-vf', "select='gt(scene,0.3)',showinfo",
          '-f', 'null', '-'
        ], jobId);

        const regex = /\[Parsed_showinfo[^\]]*\][^\n]*pts_time:([\d.]+)/g;
        let match;
        while ((match = regex.exec(stderr)) !== null) {
          const t = parseFloat(match[1]);
          if (t > 0.5) visualScenes.push(t);
        }
        // Deduplicate within 1.5s
        visualScenes = visualScenes.filter((t, i) =>
          i === 0 || t - visualScenes[i - 1] > 1.5
        );
        console.log(`[${jobId}] Found ${visualScenes.length} visual scene cuts`);
      } catch (e) {
        console.log(`[${jobId}] Visual detection failed, continuing with transcript only:`, e.message);
      }
    }

    // Step 3: Send to Gemini for topic-based scene detection
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    // Build transcript with timestamps (sample every few words to keep prompt size manageable)
    const formattedTranscript = transcription.words
      .map(w => `[${w.start.toFixed(1)}s] ${w.text}`)
      .join(' ');

    const visualContext = visualScenes.length > 0
      ? `\n\nVisual scene cuts detected at: ${visualScenes.map(t => t.toFixed(1) + 's').join(', ')}`
      : '';

    const prompt = `Analyze this video transcript and identify distinct SCENES based on topic changes, subject matter shifts, or natural transitions.

Transcript with timestamps:
${formattedTranscript}
${visualContext}

For each scene:
1. Provide a SHORT, DESCRIPTIVE title (2-6 words)
2. Identify the START and END timestamps
3. Rate your confidence (0.0-1.0) in the scene break

Guidelines:
- First scene starts at 0
- Scenes should be at least 10 seconds long
- Look for topic changes, speaker changes, new subjects
- Consider visual scene cuts if provided
- Aim for 3-12 scenes depending on content length
- The last scene should end at the video's duration (${videoAsset.duration.toFixed(1)}s)

Return ONLY valid JSON:
{
  "scenes": [
    {"title": "Introduction", "start": 0, "end": 45.5, "confidence": 0.95},
    {"title": "Main Discussion", "start": 45.5, "end": 120.0, "confidence": 0.8}
  ]
}`;

    console.log(`[${jobId}] Sending to Gemini for scene analysis...`);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    let responseText = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      const match = responseText.match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : { scenes: [] };
    }

    if (!result.scenes || result.scenes.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, scenes: [], totalDuration: videoAsset.duration, analyzedAssetId: videoAsset.id }));
      return;
    }

    // Step 4: Generate thumbnails for each scene
    console.log(`[${jobId}] Generating thumbnails for ${result.scenes.length} scenes...`);
    const scenes = [];
    for (let i = 0; i < result.scenes.length; i++) {
      const scene = result.scenes[i];
      const sceneId = `scene-${Date.now()}-${i}`;
      const thumbTime = Math.min(scene.start + 1, scene.end - 0.5).toFixed(2); // 1 second into scene
      const thumbPath = join(session.assetsDir, `${sceneId}_thumb.jpg`);

      try {
        await runFFmpeg([
          '-y', '-ss', thumbTime, '-i', videoAsset.path,
          '-frames:v', '1', '-vf', 'scale=320:-1', thumbPath
        ], jobId, 10000); // 10s timeout for thumbnail
      } catch (e) {
        console.log(`[${jobId}] Thumbnail failed for scene ${i}: ${e.message}`);
      }

      // Check if this scene aligns with a visual break
      const isVisualBreak = visualScenes.some(vt =>
        Math.abs(vt - scene.start) < 2.0 || Math.abs(vt - scene.end) < 2.0
      );

      scenes.push({
        id: sceneId,
        title: scene.title || `Scene ${i + 1}`,
        startTime: scene.start,
        endTime: scene.end,
        duration: scene.end - scene.start,
        thumbnailUrl: existsSync(thumbPath)
          ? `/session/${sessionId}/assets/${sceneId}_thumb.jpg`
          : null,
        confidence: scene.confidence || 0.5,
        isVisualBreak,
      });
    }

    console.log(`[${jobId}] Scene analysis complete: ${scenes.length} scenes`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      scenes,
      totalDuration: videoAsset.duration,
      analyzedAssetId: videoAsset.id,
      visualScenesCount: visualScenes.length,
    }));

  } catch (error) {
    console.error(`[${jobId}] Scene analysis error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Export Scene (single scene as video) ──────────────────────────────────
async function handleExportScene(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { assetId, startTime, endTime, title } = body;

    if (startTime === undefined || endTime === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'startTime and endTime are required' }));
      return;
    }

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated && existsSync(asset.path)) {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
      return;
    }

    console.log(`\n[${jobId}] === EXPORT SCENE ===`);
    console.log(`[${jobId}] Exporting: ${title || 'Untitled'} (${startTime}s - ${endTime}s)`);

    const duration = endTime - startTime;
    const safeTitle = (title || 'scene').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    const outputFilename = `${safeTitle}_${Date.now()}.mp4`;
    const outputPath = join(session.rendersDir, outputFilename);

    // Ensure renders directory exists
    if (!existsSync(session.rendersDir)) {
      mkdirSync(session.rendersDir, { recursive: true });
    }

    await runFFmpeg([
      '-y',
      '-ss', startTime.toString(),
      '-i', videoAsset.path,
      '-t', duration.toString(),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
    ], jobId);

    console.log(`[${jobId}] Scene exported: ${outputFilename}`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      downloadUrl: `/session/${sessionId}/renders/${outputFilename}`,
      filename: outputFilename,
      duration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Export scene error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── AI B-Roll Suggestions ──────────────────────────────────
async function handleSuggestBroll(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { assetId, includePexels = true, includeUnsplash = true, includeAI = true } = body;

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) {
        if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) {
          videoAsset = a;
          break;
        }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === B-ROLL SUGGESTIONS ===`);

    // Check if already running for this session
    if (session._brollAnalysisRunning) {
      console.log(`[${jobId}] B-roll analysis already in progress, skipping duplicate request`);
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Analysis already in progress', inProgress: true }));
      return;
    }

    // Get cached transcript or generate one
    let transcriptData = session.transcriptCache?.get(videoAsset.id);
    if (!transcriptData) {
      session._brollAnalysisRunning = true;
      console.log(`[${jobId}] Generating transcript for B-roll analysis...`);
      // Call transcription (simplified - reuse existing logic)
      const audioPath = join(session.assetsDir, `_broll_audio_${Date.now()}.mp3`);
      await runFFmpeg(['-y', '-i', videoAsset.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath], jobId);

      try {
        transcriptData = await runLocalWhisper(audioPath, jobId);
        // Save to cache for future requests
        if (!session.transcriptCache) session.transcriptCache = new Map();
        session.transcriptCache.set(videoAsset.id, {
          ...transcriptData,
          cachedAt: Date.now()
        });
        console.log(`[${jobId}] Transcript cached for future use`);
      } catch (e) {
        console.log(`[${jobId}] Whisper failed: ${e.message}`);
        // Fallback to basic transcript
        transcriptData = { text: '', words: [] };
      }

      try { unlinkSync(audioPath); } catch {}
      session._brollAnalysisRunning = false;
    } else {
      console.log(`[${jobId}] Using cached transcript`);
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    // Analyze for B-roll opportunities
    console.log(`[${jobId}] Analyzing transcript for B-roll opportunities...`);
    const opportunities = await analyzeBrollOpportunities(
      transcriptData.text || '',
      transcriptData.words || [],
      videoAsset.duration || 60,
      geminiKey
    );

    console.log(`[${jobId}] Found ${opportunities.length} B-roll opportunities`);

    // Fetch sources for each opportunity
    const suggestions = [];
    const pexelsKey = process.env.PEXELS_API_KEY;
    const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;

    for (const opp of opportunities) {
      const sources = [];

      // Search Pexels
      if (includePexels && pexelsKey) {
        try {
          const pexelsResponse = await fetch(
            `https://api.pexels.com/v1/search?query=${encodeURIComponent(opp.keyword)}&per_page=3&orientation=square`,
            { headers: { Authorization: pexelsKey } }
          );
          if (pexelsResponse.ok) {
            const pexelsData = await pexelsResponse.json();
            for (const photo of (pexelsData.photos || []).slice(0, 3)) {
              sources.push({
                type: 'pexels',
                thumbnailUrl: photo.src.small,
                fullUrl: photo.src.large,
                attribution: `Photo by ${photo.photographer} on Pexels`,
              });
            }
          }
        } catch (e) {
          console.log(`[${jobId}] Pexels search failed:`, e.message);
        }
      }

      // Search Unsplash
      if (includeUnsplash && unsplashKey) {
        try {
          const unsplashResponse = await fetch(
            `https://api.unsplash.com/search/photos?query=${encodeURIComponent(opp.keyword)}&per_page=3`,
            { headers: { Authorization: `Client-ID ${unsplashKey}` } }
          );
          if (unsplashResponse.ok) {
            const unsplashData = await unsplashResponse.json();
            for (const photo of (unsplashData.results || []).slice(0, 3)) {
              sources.push({
                type: 'unsplash',
                thumbnailUrl: photo.urls.thumb,
                fullUrl: photo.urls.regular,
                attribution: `Photo by ${photo.user.name} on Unsplash`,
              });
            }
          }
        } catch (e) {
          console.log(`[${jobId}] Unsplash search failed:`, e.message);
        }
      }

      // Add AI generation option
      if (includeAI) {
        sources.push({
          type: 'ai-generated',
          thumbnailUrl: null, // Will be generated on apply
          fullUrl: null,
          prompt: opp.prompt,
        });
      }

      suggestions.push({
        id: `broll-${Date.now()}-${suggestions.length}`,
        keyword: opp.keyword,
        timestamp: opp.timestamp,
        reason: opp.reason,
        prompt: opp.prompt,
        sources,
      });
    }

    console.log(`[${jobId}] B-roll suggestions complete: ${suggestions.length} suggestions`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      suggestions,
      analyzedAssetId: videoAsset.id,
    }));

  } catch (error) {
    console.error(`[${jobId}] B-roll suggestion error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Apply a B-roll suggestion (download and register asset)
async function handleApplyBrollSuggestion(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { suggestionId, sourceType, sourceUrl, prompt, timestamp, keyword } = body;

    console.log(`\n[${jobId}] === APPLY B-ROLL ===`);
    console.log(`[${jobId}] Type: ${sourceType}, Keyword: ${keyword}`);

    const assetId = randomUUID();
    const assetPath = join(session.assetsDir, `${assetId}.jpg`);

    if (sourceType === 'ai-generated') {
      // Generate image using Gemini
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
        return;
      }

      const success = await generateImageWithGemini(prompt, geminiKey, assetPath);
      if (!success) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Failed to generate image' }));
        return;
      }
    } else {
      // Download from Pexels/Unsplash
      if (!sourceUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'sourceUrl required for stock images' }));
        return;
      }

      console.log(`[${jobId}] Downloading from ${sourceType}...`);
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(assetPath, buffer);
      console.log(`[${jobId}] Downloaded: ${(buffer.length / 1024).toFixed(1)} KB`);
    }

    // Get image dimensions
    const info = await getMediaInfo(assetPath);

    // Generate thumbnail
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    await runFFmpeg([
      '-y', '-i', assetPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1', '-q:v', '3', thumbPath
    ], jobId);

    // Register as asset
    const asset = {
      id: assetId,
      type: 'image',
      filename: `broll_${keyword || 'image'}.jpg`,
      duration: 3, // Default 3 seconds for B-roll
      size: statSync(assetPath).size,
      width: info.width || 512,
      height: info.height || 512,
      path: assetPath,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
      aiGenerated: sourceType === 'ai-generated',
      brollKeyword: keyword,
    };
    session.assets.set(assetId, asset);
    await saveAssetMetadata(session);

    console.log(`[${jobId}] B-roll asset registered: ${assetId}`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      timestamp,
      duration: 3,
      thumbnailUrl: asset.thumbnailUrl,
      streamUrl: asset.streamUrl,
    }));

  } catch (error) {
    console.error(`[${jobId}] Apply B-roll error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── "Make it Viral" Features ──────────────────────────────────

// Analyze transcript for emphasis points (stressed words, pauses, volume peaks)
async function handleAnalyzeEmphasis(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { assetId } = body;

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) {
        if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) {
          videoAsset = a;
          break;
        }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === ANALYZE EMPHASIS ===`);

    // Get transcript
    let transcriptData = session.transcriptCache?.get(videoAsset.id);
    if (!transcriptData || !transcriptData.words?.length) {
      console.log(`[${jobId}] Generating transcript for emphasis analysis...`);
      const audioPath = join(session.assetsDir, `_emphasis_audio_${Date.now()}.mp3`);
      await runFFmpeg(['-y', '-i', videoAsset.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath], jobId);

      try {
        transcriptData = await runLocalWhisper(audioPath, jobId);
        if (!session.transcriptCache) session.transcriptCache = new Map();
        session.transcriptCache.set(videoAsset.id, transcriptData);
      } catch {
        transcriptData = { text: '', words: [] };
      }

      try { unlinkSync(audioPath); } catch {}
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    // Use Gemini to analyze emphasis points
    console.log(`[${jobId}] Analyzing emphasis points with AI...`);
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{
          text: `Analyze this transcript and identify 5-10 key emphasis points where a zoom cut would be impactful for a "viral" video edit. Look for:
- Stressed or emphasized words
- Punchlines or key statements
- Emotional peaks
- Important revelations
- Words before natural pauses
- Action words or exclamations

Transcript: "${transcriptData.text || ''}"

Word timings: ${JSON.stringify(transcriptData.words?.slice(0, 100) || [])}${(transcriptData.words?.length || 0) > 100 ? '...' : ''}

Return a JSON array with this structure:
[
  {
    "timestamp": 15.2,
    "word": "amazing",
    "confidence": 0.9,
    "type": "emphasis",
    "reason": "key revelation"
  }
]

Types: "emphasis", "punchline", "emotional", "pause", "exclamation"
Confidence: 0-1 scale

IMPORTANT: Return ONLY valid JSON array, no markdown.`
        }]
      }],
      config: { responseMimeType: 'application/json' }
    });

    let emphasisPoints = [];
    try {
      const parsed = JSON.parse(response.text || '[]');
      emphasisPoints = Array.isArray(parsed) ? parsed : [];
    } catch {
      const match = (response.text || '').match(/\[[\s\S]*\]/);
      if (match) {
        try { emphasisPoints = JSON.parse(match[0]); } catch {}
      }
    }

    console.log(`[${jobId}] Found ${emphasisPoints.length} emphasis points`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      emphasisPoints,
      totalDuration: videoAsset.duration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Analyze emphasis error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Detect slow/boring sections that could be cut
async function handleDetectSlowSections(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { assetId } = body;

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) {
        if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) {
          videoAsset = a;
          break;
        }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === DETECT SLOW SECTIONS ===`);

    // Get transcript
    let transcriptData = session.transcriptCache?.get(videoAsset.id);
    if (!transcriptData) {
      transcriptData = { text: '', words: [] };
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    // Use Gemini to find slow sections
    console.log(`[${jobId}] Analyzing for slow sections...`);
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{
          text: `Analyze this transcript and identify sections that might be slow, repetitive, or less engaging. These are candidates for cutting to make the video more "viral" and fast-paced. Look for:
- Repetitive explanations
- Long pauses or filler words
- Off-topic tangents
- Low-energy sections

Transcript: "${transcriptData.text || ''}"

Word timings: ${JSON.stringify(transcriptData.words?.slice(0, 100) || [])}

Video duration: ${videoAsset.duration}s

Return a JSON array with this structure:
[
  {
    "startTime": 30.5,
    "endTime": 45.2,
    "reason": "repetitive explanation",
    "suggestion": "Cut or speed up",
    "confidence": 0.7
  }
]

IMPORTANT: Return ONLY valid JSON array, no markdown.`
        }]
      }],
      config: { responseMimeType: 'application/json' }
    });

    let slowSections = [];
    try {
      const parsed = JSON.parse(response.text || '[]');
      slowSections = Array.isArray(parsed) ? parsed : [];
    } catch {
      const match = (response.text || '').match(/\[[\s\S]*\]/);
      if (match) {
        try { slowSections = JSON.parse(match[0]); } catch {}
      }
    }

    console.log(`[${jobId}] Found ${slowSections.length} slow sections`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      slowSections,
      totalDuration: videoAsset.duration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Detect slow sections error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Content Repurposing (Long to Shorts) ──────────────────────────

// Analyze video for potential shorts with virality scoring
async function handleAnalyzeForShorts(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const {
      targetPlatform = 'tiktok',
      maxDuration = 60,
      minDuration = 15,
      targetCount = 5,
      assetId,
    } = body;

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) {
        if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) {
          videoAsset = a;
          break;
        }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === ANALYZE FOR SHORTS ===`);
    console.log(`[${jobId}] Platform: ${targetPlatform}, Duration: ${minDuration}-${maxDuration}s, Target: ${targetCount}`);

    // Get transcript
    let transcriptData = session.transcriptCache?.get(videoAsset.id);
    if (!transcriptData || !transcriptData.words?.length) {
      console.log(`[${jobId}] Generating transcript...`);
      const audioPath = join(session.assetsDir, `_shorts_audio_${Date.now()}.mp3`);
      await runFFmpeg(['-y', '-i', videoAsset.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath], jobId);

      try {
        transcriptData = await runLocalWhisper(audioPath, jobId);
        if (!session.transcriptCache) session.transcriptCache = new Map();
        session.transcriptCache.set(videoAsset.id, transcriptData);
      } catch {
        transcriptData = { text: '', words: [] };
      }

      try { unlinkSync(audioPath); } catch {}
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    // Use Gemini to identify best segments for shorts
    console.log(`[${jobId}] Analyzing for viral short candidates...`);
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{
          text: `Analyze this video transcript and identify the ${targetCount} best segments that would make engaging short-form videos for ${targetPlatform}.

Requirements:
- Each segment should be between ${minDuration} and ${maxDuration} seconds
- Segments should be self-contained with a clear hook and payoff
- Prioritize: surprising moments, emotional peaks, actionable tips, funny moments, controversial takes

Transcript: "${transcriptData.text || ''}"

Word timings: ${JSON.stringify(transcriptData.words?.slice(0, 150) || [])}${(transcriptData.words?.length || 0) > 150 ? '...' : ''}

Video duration: ${videoAsset.duration}s

Return a JSON array with this structure:
[
  {
    "startTime": 30.5,
    "endTime": 55.2,
    "viralityScore": 85,
    "viralityFactors": ["strong hook", "emotional content", "actionable"],
    "suggestedHook": "You won't believe what happens when...",
    "suggestedTitle": "This changed everything",
    "suggestedDescription": "Short description for the platform..."
  }
]

Score 0-100 based on viral potential. Higher = more likely to perform well.

IMPORTANT: Return ONLY valid JSON array, no markdown.`
        }]
      }],
      config: { responseMimeType: 'application/json' }
    });

    let candidates = [];
    try {
      const parsed = JSON.parse(response.text || '[]');
      candidates = Array.isArray(parsed) ? parsed : [];
    } catch {
      const match = (response.text || '').match(/\[[\s\S]*\]/);
      if (match) {
        try { candidates = JSON.parse(match[0]); } catch {}
      }
    }

    // Generate thumbnails for each candidate
    console.log(`[${jobId}] Generating thumbnails for ${candidates.length} candidates...`);
    const shortsWithThumbs = [];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const thumbId = `short_${i}_${Date.now()}`;
      const thumbPath = join(session.assetsDir, `${thumbId}_thumb.jpg`);

      // Extract frame from middle of segment
      const midTime = ((c.startTime || 0) + (c.endTime || 30)) / 2;
      try {
        await runFFmpeg([
          '-y', '-ss', midTime.toFixed(2), '-i', videoAsset.path,
          '-vf', 'scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1', '-q:v', '3', thumbPath
        ], jobId);
      } catch {}

      shortsWithThumbs.push({
        id: `short-${Date.now()}-${i}`,
        startTime: c.startTime || 0,
        endTime: c.endTime || 30,
        duration: (c.endTime || 30) - (c.startTime || 0),
        viralityScore: c.viralityScore || 50,
        viralityFactors: c.viralityFactors || [],
        suggestedHook: c.suggestedHook || '',
        suggestedTitle: c.suggestedTitle || `Short ${i + 1}`,
        suggestedDescription: c.suggestedDescription || '',
        thumbnailUrl: existsSync(thumbPath)
          ? `/session/${sessionId}/assets/${thumbId}_thumb.jpg`
          : null,
        selected: true,
      });
    }

    // Sort by virality score
    shortsWithThumbs.sort((a, b) => b.viralityScore - a.viralityScore);

    console.log(`[${jobId}] Found ${shortsWithThumbs.length} short candidates`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      candidates: shortsWithThumbs,
      targetPlatform,
      analyzedAssetId: videoAsset.id,
      totalDuration: videoAsset.duration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Analyze for shorts error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Export a single short with optional 9:16 crop
async function handleExportShort(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const {
      startTime,
      endTime,
      title,
      assetId,
      cropTo916 = true,
      addHook,
      hookText,
    } = body;

    if (startTime === undefined || endTime === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'startTime and endTime required' }));
      return;
    }

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) {
        if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) {
          videoAsset = a;
          break;
        }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === EXPORT SHORT ===`);
    console.log(`[${jobId}] ${startTime}s - ${endTime}s, 9:16: ${cropTo916}`);

    const duration = endTime - startTime;
    const safeTitle = (title || 'short').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const outputFilename = `${safeTitle}_${Date.now()}.mp4`;
    const outputPath = join(session.rendersDir, outputFilename);

    if (!existsSync(session.rendersDir)) {
      mkdirSync(session.rendersDir, { recursive: true });
    }

    // Build FFmpeg command
    const ffmpegArgs = ['-y', '-ss', startTime.toString(), '-i', videoAsset.path, '-t', duration.toString()];

    if (cropTo916) {
      // Crop to 9:16 (center crop)
      ffmpegArgs.push('-vf', 'crop=ih*9/16:ih,scale=1080:1920');
    }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
    );

    await runFFmpeg(ffmpegArgs, jobId);

    console.log(`[${jobId}] Short exported: ${outputFilename}`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      downloadUrl: `/session/${sessionId}/renders/${outputFilename}`,
      filename: outputFilename,
      duration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Export short error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 1: Auto-Reframe ──────────────────────────────────
async function handleAutoReframe(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { targetAspect = '9:16', assetId } = body;

    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) { if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) { videoAsset = a; break; } }
    }
    if (!videoAsset) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No video asset found' })); return; }

    console.log(`\n[${jobId}] === AUTO-REFRAME (${targetAspect}) ===`);
    const info = await getMediaInfo(videoAsset.path);
    const { width: srcW, height: srcH, duration } = info;

    // Target dimensions for each aspect ratio
    const TARGET = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };
    const [tgtW, tgtH] = TARGET[targetAspect] || TARGET['9:16'];

    // Crop region: keep full height, reduce width to match target ratio
    const cropW = Math.round(srcH * tgtW / tgtH);
    if (cropW > srcW) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: `Source (${srcW}×${srcH}) is already portrait or square — cannot reframe to ${targetAspect}` })); return; }

    // Extract 3 sample frames for subject detection
    const apiKey = process.env.GEMINI_API_KEY;
    let subjectCenterX = 0.5; // default: center crop
    if (apiKey) {
      const ai = new GoogleGenAI({ apiKey });
      const sampleTimes = [0.25, 0.5, 0.75].map(t => Math.max(0.5, duration * t).toFixed(2));
      let sumX = 0, countX = 0;
      for (const t of sampleTimes) {
        const framePath = join(session.assetsDir, `_rf_${t}.jpg`);
        try {
          await runFFmpeg(['-y', '-ss', t, '-i', videoAsset.path, '-frames:v', '1', '-q:v', '3', framePath], jobId);
          const b64 = readFileSync(framePath).toString('base64');
          const r = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [
              { inlineData: { mimeType: 'image/jpeg', data: b64 } },
              { text: 'Where is the main subject or face? Return JSON only: {"subjectCenterX":0.5} where 0.0=left edge, 1.0=right edge. If unclear, use 0.5.' }
            ]}],
            config: { responseMimeType: 'application/json' },
          });
          const parsed = JSON.parse(r.candidates[0].content.parts[0].text);
          if (typeof parsed.subjectCenterX === 'number') { sumX += parsed.subjectCenterX; countX++; }
        } catch (e) { console.log(`[${jobId}] Frame ${t}s analysis skipped: ${e.message}`); }
        finally { try { unlinkSync(framePath); } catch {} }
      }
      if (countX > 0) subjectCenterX = sumX / countX;
    }

    const cropX = Math.max(0, Math.min(srcW - cropW, Math.round(subjectCenterX * srcW - cropW / 2)));
    console.log(`[${jobId}] Subject at ${(subjectCenterX * 100).toFixed(0)}% → cropX=${cropX}, crop=${cropW}×${srcH} → ${tgtW}×${tgtH}`);

    const outputPath = join(session.assetsDir, `${videoAsset.id}_rf.mp4`);
    await runFFmpeg(['-y', '-i', videoAsset.path, '-vf', `crop=${cropW}:${srcH}:${cropX}:0,scale=${tgtW}:${tgtH}`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'copy', outputPath], jobId);
    renameSync(outputPath, videoAsset.path);
    videoAsset.width = tgtW; videoAsset.height = tgtH;

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, originalDimensions: { width: srcW, height: srcH }, newDimensions: { width: tgtW, height: tgtH }, targetAspect, subjectCenterX: Math.round(subjectCenterX * 100), assetId: videoAsset.id }));
  } catch (error) {
    console.error(`[${jobId}] Auto-reframe error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 2: Background Music Auto-Ducking ─────────────────
async function handleAutoDuck(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { musicAssetId, videoAssetId, duckLevel = 0.15, duckFade = 0.3 } = body;
    // duckLevel: music volume during speech (0.0-1.0, default 0.15 = -16dB)
    // duckFade: fade in/out duration in seconds

    const musicAsset = session.assets.get(musicAssetId);
    const videoAsset = videoAssetId ? session.assets.get(videoAssetId) : (() => { for (const a of session.assets.values()) { if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) return a; } return null; })();
    if (!musicAsset || !videoAsset) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'musicAssetId and a video asset are required' })); return; }

    console.log(`\n[${jobId}] === AUTO-DUCK ===`);

    // Detect speech segments via silencedetect (inverted — silence = no speech)
    const silenceStderr = await runFFmpeg(['-hide_banner', '-i', videoAsset.path, '-af', 'silencedetect=noise=-30dB:duration=0.3', '-f', 'null', '-'], jobId);
    const silenceRanges = [];
    const silRegex = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
    let m;
    while ((m = silRegex.exec(silenceStderr)) !== null) {
      silenceRanges.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
    }

    const info = await getMediaInfo(videoAsset.path);
    const videoDuration = info.duration;

    // Build speech segments (inverse of silence)
    const speechSegments = [];
    let cursor = 0;
    for (const s of silenceRanges) {
      if (s.start > cursor + 0.1) speechSegments.push({ start: cursor, end: s.start });
      cursor = s.end;
    }
    if (cursor < videoDuration - 0.1) speechSegments.push({ start: cursor, end: videoDuration });

    // Build volume expression: full volume during silence/music, ducked during speech
    // Use a piecewise expression with fades
    let volExpr = '1'; // default full volume
    if (speechSegments.length > 0) {
      const parts = speechSegments.map(seg => {
        const fadeIn = seg.start + duckFade;
        const fadeOut = seg.end - duckFade;
        if (fadeOut <= fadeIn) return `if(between(t,${seg.start},${seg.end}),${duckLevel},1)`;
        return `if(lt(t,${seg.start}),1,if(lt(t,${fadeIn}),lerp(1,${duckLevel},(t-${seg.start})/${duckFade}),if(lt(t,${fadeOut}),${duckLevel},if(lt(t,${seg.end}),lerp(${duckLevel},1,(t-${fadeOut})/${duckFade}),1))))`;
      });
      volExpr = parts.length === 1 ? parts[0] : `min(${parts.join(',')})`;
    }

    const outputPath = join(session.assetsDir, `${musicAsset.id}_ducked.mp3`);
    await runFFmpeg(['-y', '-i', musicAsset.path, '-af', `volume='${volExpr}':eval=frame`, '-c:a', 'libmp3lame', '-q:a', '2', outputPath], jobId);
    renameSync(outputPath, musicAsset.path);

    console.log(`[${jobId}] Auto-ducked ${speechSegments.length} speech segments`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, speechSegments: speechSegments.length, duckLevel, assetId: musicAsset.id }));
  } catch (error) {
    console.error(`[${jobId}] Auto-duck error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 5: Silence Preview ───────────────────────────────
async function handleSilencePreview(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { threshold = -26, minDuration = 0.4 } = body;

    let videoAsset = null;
    for (const a of session.assets.values()) { if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) { videoAsset = a; break; } }
    if (!videoAsset) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No video asset found' })); return; }

    console.log(`\n[${jobId}] === SILENCE PREVIEW ===`);
    const stderr = await runFFmpeg(['-hide_banner', '-i', videoAsset.path, '-af', `silencedetect=noise=${threshold}dB:duration=${minDuration}`, '-f', 'null', '-'], jobId);

    const silences = [];
    const re = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
    let match;
    while ((match = re.exec(stderr)) !== null) {
      silences.push({ start: parseFloat(match[1]), end: parseFloat(match[2]), duration: parseFloat(match[3]) });
    }
    const totalSilence = silences.reduce((s, seg) => s + seg.duration, 0);
    const info = await getMediaInfo(videoAsset.path);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, silences, totalSilence: Math.round(totalSilence * 10) / 10, videoDuration: info.duration, wouldReduceTo: Math.round((info.duration - totalSilence) * 10) / 10 }));
  } catch (error) {
    console.error(`[${jobId}] Silence preview error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 6: Highlight Reel ────────────────────────────────
async function handleHighlightReel(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { targetDuration = 60, transcript } = body;

    let videoAsset = null;
    for (const a of session.assets.values()) { if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) { videoAsset = a; break; } }
    if (!videoAsset) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No video asset found' })); return; }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' })); return; }

    const info = await getMediaInfo(videoAsset.path);
    console.log(`\n[${jobId}] === HIGHLIGHT REEL (target: ${targetDuration}s) ===`);

    const ai = new GoogleGenAI({ apiKey });

    // Get transcript (use provided or extract audio for Gemini)
    let transcriptText = transcript;
    if (!transcriptText) {
      const audioPath = join(session.assetsDir, `_hl_audio.mp3`);
      await runFFmpeg(['-y', '-i', videoAsset.path, '-ac', '1', '-ar', '16000', '-b:a', '64k', audioPath], jobId);
      const audioB64 = readFileSync(audioPath).toString('base64');
      try { unlinkSync(audioPath); } catch {}
      const transcribeResult = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mp3', data: audioB64 } }, { text: 'Transcribe this audio with timestamps. Format: [Xs] word [Xs] word...' }] }],
      });
      transcriptText = transcribeResult.candidates[0].content.parts[0].text;
    }

    // Ask Gemini to pick the best moments
    const pickPrompt = `You are editing a ${info.duration.toFixed(0)}-second video into a ${targetDuration}-second highlight reel.

Transcript:
${transcriptText.substring(0, 8000)}

Pick the most engaging, informative, or entertaining moments. Return JSON:
{
  "segments": [
    { "start": 5.0, "end": 18.0, "reason": "Strong hook" },
    { "start": 45.0, "end": 62.0, "reason": "Key insight" }
  ],
  "totalDuration": 58
}

Rules:
- Total of all segments must be approximately ${targetDuration} seconds
- Minimum segment length: 3 seconds, maximum: 30 seconds
- No overlapping segments
- Prefer segments with strong statements, key insights, or high energy`;

    const pickResult = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: pickPrompt }] }],
      config: { responseMimeType: 'application/json' },
    });
    const pickData = JSON.parse(pickResult.candidates[0].content.parts[0].text);
    const segments = pickData.segments || [];

    if (segments.length === 0) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No segments identified' })); return; }

    // Extract each segment and concatenate
    const segmentPaths = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segPath = join(session.assetsDir, `_hl_seg_${i}.mp4`);
      await runFFmpeg(['-y', '-ss', `${seg.start}`, '-t', `${seg.end - seg.start}`, '-i', videoAsset.path, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', segPath], jobId);
      segmentPaths.push(segPath);
    }

    // Concatenate with concat demuxer
    const concatList = join(session.assetsDir, '_hl_concat.txt');
    writeFileSync(concatList, segmentPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    const reelId = randomUUID();
    const reelPath = join(session.assetsDir, `${reelId}.mp4`);
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', reelPath], jobId);

    // Cleanup temp files
    for (const p of segmentPaths) { try { unlinkSync(p); } catch {} }
    try { unlinkSync(concatList); } catch {}

    // Register as new asset
    const reelInfo = await getMediaInfo(reelPath);
    const thumbPath = join(session.assetsDir, `${reelId}_thumb.jpg`);
    try { await runFFmpeg(['-y', '-i', reelPath, '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2', '-frames:v', '1', thumbPath], jobId); } catch {}

    const reelAsset = {
      id: reelId, type: 'video', filename: `highlight_reel_${targetDuration}s.mp4`,
      duration: reelInfo.duration, size: statSync(reelPath).size,
      width: reelInfo.width, height: reelInfo.height,
      path: reelPath,
      thumbnailUrl: `/session/${sessionId}/assets/${reelId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${reelId}/stream`,
      aiGenerated: false,
    };
    session.assets.set(reelId, reelAsset);

    console.log(`[${jobId}] Highlight reel: ${segments.length} segments → ${reelInfo.duration.toFixed(1)}s`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, assetId: reelId, segments, totalDuration: reelInfo.duration }));
  } catch (error) {
    console.error(`[${jobId}] Highlight reel error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 7: Caption Translation ──────────────────────────
async function handleTranslateCaptions(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { language, captionWords } = body; // captionWords: [{text, start, end}]

    if (!language || !captionWords || captionWords.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'language and captionWords are required' })); return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' })); return; }

    console.log(`\n[${jobId}] === TRANSLATE CAPTIONS → ${language} (${captionWords.length} words) ===`);
    const ai = new GoogleGenAI({ apiKey });

    const text = captionWords.map(w => w.text).join(' ');
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: `Translate this text to ${language}. Return ONLY the translated words as a JSON array of strings, one per original word (preserve word count exactly): ${JSON.stringify(captionWords.map(w => w.text))}` }] }],
      config: { responseMimeType: 'application/json' },
    });

    let translatedWords = JSON.parse(result.candidates[0].content.parts[0].text);
    // If Gemini returns an array of arrays or nested, flatten
    if (Array.isArray(translatedWords[0])) translatedWords = translatedWords.flat();

    // Pair translated words with original timestamps
    // If word counts differ, distribute translated words proportionally
    const translated = captionWords.map((w, i) => ({
      text: translatedWords[i] || '',
      start: w.start,
      end: w.end,
    })).filter(w => w.text);

    console.log(`[${jobId}] Translated ${captionWords.length} words to ${language}`);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, words: translated, language, originalText: text }));
  } catch (error) {
    console.error(`[${jobId}] Translate captions error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 8: Thumbnail Generator ──────────────────────────
async function handleGenerateThumbnail(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { timestamp, assetId } = body;

    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) { for (const a of session.assets.values()) { if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) { videoAsset = a; break; } } }
    if (!videoAsset) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'No video asset found' })); return; }

    console.log(`\n[${jobId}] === THUMBNAIL GENERATOR (t=${timestamp ?? 'best'}) ===`);

    const thumbId = randomUUID();
    const thumbPath = join(session.assetsDir, `${thumbId}.jpg`);
    const ss = timestamp != null ? `${timestamp}` : null;

    // If no timestamp, extract at 25%, 50%, 75% and pick the sharpest (highest Laplacian variance)
    if (!ss) {
      const info = await getMediaInfo(videoAsset.path);
      const candidates = [0.25, 0.5, 0.75].map(t => ({ t: (info.duration * t).toFixed(2), path: join(session.assetsDir, `_tc_${t}.jpg`) }));
      let bestPath = candidates[1].path; // default: 50%
      let bestScore = -1;

      for (const c of candidates) {
        try {
          await runFFmpeg(['-y', '-ss', c.t, '-i', videoAsset.path, '-frames:v', '1', '-vf', 'scale=320:180', '-q:v', '3', c.path], jobId);
          // Use FFmpeg's blur detection as sharpness proxy
          const blurResult = await runFFmpeg(['-i', c.path, '-vf', 'sobel,metadata=mode=print:file=-', '-frames:v', '1', '-f', 'null', '-'], jobId).catch(() => '');
          const score = blurResult.length; // longer output = more edges = sharper
          if (score > bestScore) { bestScore = score; bestPath = c.path; }
        } catch {}
      }
      // Copy best to final path
      const bestData = readFileSync(bestPath);
      writeFileSync(thumbPath, bestData);
      for (const c of candidates) { try { unlinkSync(c.path); } catch {} }
    } else {
      await runFFmpeg(['-y', '-ss', ss, '-i', videoAsset.path, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2', '-q:v', '2', thumbPath], jobId);
    }

    // Register as image asset
    const thumbAsset = {
      id: thumbId, type: 'image', filename: `thumbnail_${ss || 'best'}.jpg`,
      duration: 0, size: statSync(thumbPath).size,
      width: 1280, height: 720, path: thumbPath,
      thumbnailUrl: `/session/${sessionId}/assets/${thumbId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${thumbId}/stream`,
      aiGenerated: false,
    };
    session.assets.set(thumbId, thumbAsset);
    // Use itself as thumbnail
    try { const d = readFileSync(thumbPath); writeFileSync(join(session.assetsDir, `${thumbId}_thumb.jpg`), d); } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, assetId: thumbId, filename: thumbAsset.filename }));
  } catch (error) {
    console.error(`[${jobId}] Thumbnail error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 8b: YouTube Thumbnail Generator ──────────────────
async function handleGenerateYoutubeThumbnail(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const {
      mode = 'best-frame', // 'best-frame' | 'specific-time' | 'variants'
      timestamp,
      style = 'youtube', // 'youtube' | 'dramatic' | 'minimal'
      textOverlay,
      variantCount = 3,
      assetId,
    } = body;

    // Find video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const a of session.assets.values()) {
        if (a.type === 'video' && !a.aiGenerated && existsSync(a.path)) {
          videoAsset = a;
          break;
        }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === YOUTUBE THUMBNAIL GENERATOR ===`);
    console.log(`[${jobId}] Mode: ${mode}, Style: ${style}, Variants: ${variantCount}`);

    // AI-GENERATED MODE: Create eye-catching thumbnail from video theme
    if (mode === 'ai-generated') {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
        return;
      }

      // Get transcript for context
      let transcriptData = session.transcriptCache?.get(videoAsset.id);
      if (!transcriptData) {
        console.log(`[${jobId}] Generating transcript for thumbnail analysis...`);
        const audioPath = join(session.assetsDir, `_thumb_audio_${Date.now()}.mp3`);
        await runFFmpeg(['-y', '-i', videoAsset.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-t', '300', audioPath], jobId);
        try {
          transcriptData = await runLocalWhisper(audioPath, jobId);
          if (!session.transcriptCache) session.transcriptCache = new Map();
          session.transcriptCache.set(videoAsset.id, { ...transcriptData, cachedAt: Date.now() });
        } catch {
          transcriptData = { text: '', words: [] };
        }
        try { unlinkSync(audioPath); } catch {}
      }

      // Use Gemini to create a creative thumbnail prompt
      console.log(`[${jobId}] Generating creative thumbnail prompt...`);
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const promptResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [{
            text: `You are a YouTube thumbnail designer. Based on this video transcript, create a compelling thumbnail prompt for AI image generation.

Transcript: "${(transcriptData.text || '').substring(0, 2000)}"

Create a SINGLE detailed prompt for an eye-catching YouTube thumbnail. Consider:
- The main topic/theme of the video
- What would make someone click on this video
- Bold, vibrant imagery that stands out
- Expressions, emotions, or dramatic scenes
- NO text in the image (text overlays are added separately)

Guidelines for the prompt:
- Be SPECIFIC and DETAILED (40-60 words)
- Request photorealistic or high-quality 3D render style
- Include dramatic lighting (studio lighting, rim light, neon glow)
- Specify bold colors and high contrast
- Describe composition (close-up face, centered subject, dynamic angle)
- Include quality modifiers (8K, cinematic, professional, trending on artstation)
- Example styles: "dramatic portrait", "product hero shot", "concept art", "cinematic still"

Return ONLY the prompt text, no explanation or formatting.`
          }]
        }]
      });

      const thumbnailPrompt = promptResponse.text?.trim() || 'Professional YouTube thumbnail, dramatic lighting, bold colors, 8K quality';
      console.log(`[${jobId}] Generated prompt: ${thumbnailPrompt.substring(0, 100)}...`);

      // Generate multiple variants with fal.ai
      const variants = [];
      const variantsToGenerate = Math.min(variantCount, 4);

      for (let i = 0; i < variantsToGenerate; i++) {
        try {
          console.log(`[${jobId}] Generating AI thumbnail ${i + 1}/${variantsToGenerate}...`);

          const result = await fal.run('fal-ai/nano-banana-pro', {
            input: {
              prompt: `${thumbnailPrompt}. YouTube thumbnail style, no text in image.`,
              num_images: 1,
              aspect_ratio: '16:9',
              resolution: '1K',
              output_format: 'png',
            },
          });

          const images = result?.images || result?.data?.images || [];
          if (images.length > 0) {
            const imageUrl = images[0].url || images[0];
            const response = await fetch(imageUrl);
            if (response.ok) {
              const variantId = randomUUID();
              const variant1080Path = join(session.assetsDir, `${variantId}_1080.jpg`);
              const variant720Path = join(session.assetsDir, `${variantId}_720.jpg`);

              const buffer = Buffer.from(await response.arrayBuffer());
              writeFileSync(variant1080Path, buffer);

              // Create 720p version
              await runFFmpeg(['-y', '-i', variant1080Path, '-vf', 'scale=1280:720', '-q:v', '2', variant720Path], jobId);

              // Create thumbnail
              await runFFmpeg(['-y', '-i', variant1080Path, '-vf', 'scale=160:90', '-q:v', '3', join(session.assetsDir, `${variantId}_thumb.jpg`)], jobId);

              // Register asset
              session.assets.set(variantId, {
                id: variantId,
                type: 'image',
                filename: `ai_thumb_${i + 1}_1080p.jpg`,
                duration: 0,
                size: buffer.length,
                width: 1920,
                height: 1080,
                path: variant1080Path,
                thumbnailUrl: `/session/${sessionId}/assets/${variantId}/thumbnail`,
                streamUrl: `/session/${sessionId}/assets/${variantId}/stream`,
                aiGenerated: true,
              });

              // Save 720p to renders
              if (!existsSync(session.rendersDir)) mkdirSync(session.rendersDir, { recursive: true });
              writeFileSync(join(session.rendersDir, `${variantId}_720.jpg`), readFileSync(variant720Path));

              variants.push({
                assetId: variantId,
                thumbnailUrl: `/session/${sessionId}/assets/${variantId}/thumbnail`,
                downloadUrl1080: `/session/${sessionId}/assets/${variantId}/stream`,
                downloadUrl720: `/session/${sessionId}/renders/${variantId}_720.jpg`,
                label: `AI Variant ${i + 1}`,
                timestamp: 0,
                style: 'ai-generated',
                score: 100 - i,
                prompt: thumbnailPrompt,
              });

              console.log(`[${jobId}] AI thumbnail ${i + 1} generated successfully`);
            }
          }
        } catch (e) {
          console.log(`[${jobId}] Failed to generate AI thumbnail ${i + 1}:`, e.message);
        }
      }

      if (variants.length === 0) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Failed to generate any AI thumbnails' }));
        return;
      }

      await saveAssetMetadata(session);

      console.log(`[${jobId}] Generated ${variants.length} AI thumbnail variants`);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        success: true,
        variants,
        recommendedIndex: 0,
        explanation: 'AI-generated thumbnails based on video content.',
        prompt: thumbnailPrompt, // Include prompt for copy/paste
      }));
      return;
    }

    const info = await getMediaInfo(videoAsset.path);
    const duration = info.duration || 10;

    // Determine timestamps to extract
    let extractTimes = [];
    if (mode === 'specific-time' && timestamp != null) {
      extractTimes = [timestamp];
    } else if (mode === 'variants') {
      // Extract at multiple points for variety
      extractTimes = [];
      for (let i = 0; i < variantCount; i++) {
        extractTimes.push(duration * (0.1 + (0.8 * i / (variantCount - 1 || 1))));
      }
    } else {
      // best-frame mode: extract candidates and score
      extractTimes = [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9].map(t => duration * t);
    }

    // Style filters
    const styleFilters = {
      youtube: 'eq=saturation=1.2:brightness=0.05,unsharp=5:5:0.8',
      dramatic: 'eq=contrast=1.3:saturation=1.1,colorbalance=rs=0.1:gs=-0.05:bs=-0.1',
      minimal: 'eq=brightness=0.02',
    };

    const styleFilter = styleFilters[style] || styleFilters.youtube;

    // Extract and process frames
    const candidates = [];
    for (let i = 0; i < extractTimes.length; i++) {
      const t = extractTimes[i].toFixed(2);
      const tempPath = join(session.assetsDir, `_yt_thumb_${i}.jpg`);

      try {
        // Extract frame with style enhancement
        let vf = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,${styleFilter}`;

        await runFFmpeg([
          '-y', '-ss', t, '-i', videoAsset.path,
          '-frames:v', '1',
          '-vf', vf,
          '-q:v', '2',
          tempPath
        ], jobId);

        // Score using edge detection (sharpness)
        let score = 0;
        try {
          const edgeResult = await runFFmpeg([
            '-i', tempPath,
            '-vf', 'sobel,metadata=mode=print:file=-',
            '-frames:v', '1', '-f', 'null', '-'
          ], jobId).catch(() => '');
          score = edgeResult.length; // More edges = sharper = better
        } catch {}

        candidates.push({
          timestamp: parseFloat(t),
          tempPath,
          score,
        });
      } catch (e) {
        console.log(`[${jobId}] Failed to extract at ${t}s:`, e.message);
      }
    }

    if (candidates.length === 0) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Failed to extract any frames' }));
      return;
    }

    // Sort by score and take top variants
    candidates.sort((a, b) => b.score - a.score);
    const topCandidates = mode === 'best-frame'
      ? [candidates[0]]
      : candidates.slice(0, variantCount);

    // Process each variant (add text overlay if specified)
    const variants = [];
    for (let i = 0; i < topCandidates.length; i++) {
      const c = topCandidates[i];
      const variantId = randomUUID();
      const variant1080Path = join(session.assetsDir, `${variantId}_1080.jpg`);
      const variant720Path = join(session.assetsDir, `${variantId}_720.jpg`);

      // Copy/process to final paths
      if (textOverlay && textOverlay.text) {
        // Add text overlay using drawtext
        const { text, position = 'bottom', fontSize = 'large', color = '#ffffff' } = textOverlay;
        const fontSizes = { small: 48, medium: 72, large: 96 };
        const fSize = fontSizes[fontSize] || 72;
        const yPos = position === 'top' ? '50' : position === 'center' ? '(h-text_h)/2' : 'h-text_h-80';

        // Escape text for FFmpeg
        const escapedText = text.replace(/'/g, "'\\''").replace(/:/g, '\\:');

        await runFFmpeg([
          '-y', '-i', c.tempPath,
          '-vf', `drawtext=text='${escapedText}':fontsize=${fSize}:fontcolor=${color}:x=(w-text_w)/2:y=${yPos}:borderw=4:bordercolor=black`,
          '-q:v', '2',
          variant1080Path
        ], jobId);
      } else {
        // Just copy
        const data = readFileSync(c.tempPath);
        writeFileSync(variant1080Path, data);
      }

      // Create 720p version
      await runFFmpeg([
        '-y', '-i', variant1080Path,
        '-vf', 'scale=1280:720',
        '-q:v', '2',
        variant720Path
      ], jobId);

      // Register as assets
      const asset1080 = {
        id: variantId,
        type: 'image',
        filename: `youtube_thumb_${i + 1}_1080p.jpg`,
        duration: 0,
        size: statSync(variant1080Path).size,
        width: 1920,
        height: 1080,
        path: variant1080Path,
        thumbnailUrl: `/session/${sessionId}/assets/${variantId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${variantId}/stream`,
        aiGenerated: false,
      };
      session.assets.set(variantId, asset1080);

      // Copy as thumbnail
      try {
        await runFFmpeg(['-y', '-i', variant1080Path, '-vf', 'scale=160:90', '-q:v', '3', join(session.assetsDir, `${variantId}_thumb.jpg`)], jobId);
      } catch {}

      variants.push({
        assetId: variantId,
        thumbnailUrl: `/session/${sessionId}/assets/${variantId}/thumbnail`,
        downloadUrl1080: `/session/${sessionId}/assets/${variantId}/stream`,
        downloadUrl720: `/session/${sessionId}/renders/${variantId}_720.jpg`,
        label: `Variant ${i + 1}`,
        timestamp: c.timestamp,
        style,
        score: c.score,
      });

      // Also save 720p to renders for download
      const renders720Path = join(session.rendersDir, `${variantId}_720.jpg`);
      if (!existsSync(session.rendersDir)) mkdirSync(session.rendersDir, { recursive: true });
      const data720 = readFileSync(variant720Path);
      writeFileSync(renders720Path, data720);
    }

    // Clean up temp files
    for (const c of candidates) {
      try { unlinkSync(c.tempPath); } catch {}
    }

    // Find recommended variant (highest score)
    const recommendedIndex = 0; // Already sorted by score

    console.log(`[${jobId}] Generated ${variants.length} thumbnail variants`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      variants,
      recommendedIndex,
      explanation: `Selected frames with highest visual quality. Style: ${style}.`,
    }));

  } catch (error) {
    console.error(`[${jobId}] YouTube thumbnail error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ─── Feature 9: Waveform Data ─────────────────────────────────
async function handleWaveformData(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
  const jobId = sessionId.substring(0, 8);
  try {
    const body = await parseBody(req);
    const { assetId, samples = 200 } = body;

    const asset = assetId ? session.assets.get(assetId) : null;
    if (!asset || !existsSync(asset.path)) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: 'Asset not found' })); return; }

    // Use FFmpeg astats to get RMS amplitude per segment
    const info = await getMediaInfo(asset.path);
    const duration = info.duration || 1;
    const segmentSize = duration / samples;

    const stdout = await runFFmpegProbe([
      '-i', asset.path,
      '-af', `asetnsamples=${Math.max(1, Math.floor(segmentSize * 44100))},astats=metadata=1:reset=1`,
      '-f', 'null', '-'
    ], jobId).catch(() => '');

    // Parse RMS from stderr by running with FFmpeg and reading stderr
    const stderr = await runFFmpeg([
      '-hide_banner', '-i', asset.path,
      '-af', `asetnsamples=${Math.max(1, Math.floor(segmentSize * 44100))},astats=metadata=1:reset=1`,
      '-f', 'null', '-'
    ], jobId).catch(() => '');

    // Extract RMS values
    const rmsValues = [];
    const rmsRegex = /lavfi\.astats\.(Overall\.)?RMS_level=([0-9.-]+)/g;
    let rm;
    while ((rm = rmsRegex.exec(stderr)) !== null) {
      const db = parseFloat(rm[2]);
      // Convert dB to 0-1 linear (clamp at -60dB floor)
      const linear = Math.max(0, Math.min(1, (db + 60) / 60));
      rmsValues.push(linear);
    }

    // Fallback: if no RMS data, use flat line at 0.3
    const waveform = rmsValues.length > 0
      ? rmsValues.slice(0, samples)
      : Array(samples).fill(0.3);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, waveform, duration, samples: waveform.length }));
  } catch (error) {
    console.error(`[${jobId}] Waveform error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleMuteSegments(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { segments, assetId } = body; // segments: [{start, end}, ...]

    if (!segments || segments.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'segments array is required' }));
      return;
    }

    // Find the target video asset
    let videoAsset = assetId ? session.assets.get(assetId) : null;
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated && existsSync(asset.path)) { videoAsset = asset; break; }
      }
    }
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`\n[${jobId}] === MUTE SEGMENTS ===`);
    console.log(`[${jobId}] Muting ${segments.length} segment(s) in: ${videoAsset.filename}`);

    // Build FFmpeg volume=0 expression for all segments
    // e.g. "volume=enable='between(t,0.5,0.8)+between(t,1.2,1.5)':volume=0"
    const muteExpr = segments.map(s => `between(t,${s.start},${s.end})`).join('+');
    const outputPath = join(session.assetsDir, `${videoAsset.id}_muted.mp4`);

    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-af', `volume=enable='${muteExpr}':volume=0`,
      '-c:v', 'copy',
      '-c:a', 'aac',
      outputPath
    ], jobId);

    // Replace original file in-place
    renameSync(outputPath, videoAsset.path);

    console.log(`[${jobId}] Muted ${segments.length} segment(s) — file replaced in-place`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, mutedCount: segments.length, assetId: videoAsset.id }));

  } catch (error) {
    console.error(`[${jobId}] Mute segments error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleResequence(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    const body = await parseBody(req);
    const { instruction, transcript } = body;

    if (!instruction) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'instruction is required' }));
      return;
    }

    if (!transcript) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'transcript is required — add captions first' }));
      return;
    }

    console.log(`\n[${jobId}] === RESEQUENCE ===`);
    console.log(`[${jobId}] Instruction: ${instruction}`);

    const { GoogleGenAI } = await import('@google/genai');
    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `You are a video editor assistant. Given a transcript with timestamps and a resequencing instruction, return a JSON array of section swaps.

Transcript (format: "[Xs] word"):
${transcript.substring(0, 6000)}

Instruction: "${instruction}"

Identify the sections the user wants to move. Return JSON like:
{
  "swaps": [
    { "from": { "startTime": 12.5, "endTime": 28.0, "label": "pricing section" },
      "to":   { "startTime": 45.0, "endTime": 60.0, "label": "demo section" } }
  ],
  "explanation": "Moving pricing (12.5s-28s) before demo (45s-60s)"
}

Rules:
- startTime/endTime are seconds (floats)
- Each swap moves the "from" section to where "to" currently is
- If a section can't be identified from the transcript, set it to null
- Return ONLY valid JSON, no markdown`;

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json' },
    });

    const responseText = result.candidates[0].content.parts[0].text;
    const data = JSON.parse(responseText);

    console.log(`[${jobId}] Resequence plan:`, JSON.stringify(data));

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, ...data }));

  } catch (error) {
    console.error(`[${jobId}] Resequence error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleGenerateBroll(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    console.log(`\n[${jobId}] === GENERATE B-ROLL IMAGES ===`);

    // Check for Gemini API key
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured in .dev.vars' }));
      return;
    }

    // Find the original (non-AI-generated) video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video') { videoAsset = asset; break; }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename}`);

    // Parse optional pre-built transcript+words from request body (skips Whisper)
    let preBuiltTranscription = null;
    try {
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > 0) {
        const bodyData = await new Promise((resolve) => {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        });
        if (bodyData.words && bodyData.words.length > 0) {
          preBuiltTranscription = { text: bodyData.text || '', words: bodyData.words };
        }
      }
    } catch { /* ignore */ }

    const totalDuration = await getVideoDuration(videoAsset.path);

    let transcription;

    if (preBuiltTranscription) {
      // Fast path: use pre-built caption words — skip Whisper entirely
      console.log(`[${jobId}] Step 1: Using pre-built caption data (${preBuiltTranscription.words.length} words) — skipping transcription`);
      transcription = preBuiltTranscription;
    } else {
      // Standard path: transcribe the video
      console.log(`[${jobId}] Step 1: Transcribing video...`);
      const audioPath = join(TEMP_DIR, `${jobId}-broll-audio.mp3`);

      // Check for transcription method
      const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Extract audio
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    let transcription;
    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to Gemini...`);
        const audioBuffer = readFileSync(audioPath);
        const audioBase64 = audioBuffer.toString('base64');
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
            { text: `Transcribe this audio with word timestamps. Duration: ${totalDuration}s. Return JSON: {"text": "...", "words": [{"text": "word", "start": 0.0, "end": 0.5}]}` }
          ]}]
        });
        const respText = response.text || '';
        try {
          transcription = JSON.parse(respText);
        } catch {
          const match = respText.match(/\{[\s\S]*\}/);
          transcription = match ? JSON.parse(match[0]) : { text: respText, words: [] };
        }
      }
    } else if (openaiKey) {
      console.log(`[${jobId}]    Using OpenAI Whisper API...`);
      const audioBuffer = readFileSync(audioPath);
      const formData = new globalThis.FormData();
      formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: formData,
      });

      if (!whisperResponse.ok) {
        throw new Error(`Whisper API error: ${whisperResponse.status}`);
      }

      const whisperResult = await whisperResponse.json();
      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map(w => ({
          text: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        }))
      };
    } else {
      // Use Gemini for transcription
      console.log(`[${jobId}]    Using Gemini for transcription...`);
      const audioBuffer = readFileSync(audioPath);
      const audioBase64 = audioBuffer.toString('base64');

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
            { text: `Transcribe this audio with word timestamps. Duration: ${totalDuration}s. Return JSON: {"text": "...", "words": [{"text": "word", "start": 0.0, "end": 0.5}]}` }
          ]
        }]
      });

      const respText = response.text || '';
      try {
        transcription = JSON.parse(respText);
      } catch {
        const match = respText.match(/\{[\s\S]*\}/);
        transcription = match ? JSON.parse(match[0]) : { text: respText, words: [] };
      }
    }

      try { unlinkSync(audioPath); } catch {}
    } // end else (standard transcription path)

    console.log(`[${jobId}]    Transcript: "${transcription.text.substring(0, 100)}..."`);
    console.log(`[${jobId}]    Words: ${transcription.words?.length || 0}`);

    // Step 2: Analyze transcript for B-roll opportunities
    console.log(`[${jobId}] Step 2: Analyzing for B-roll opportunities...`);
    const opportunities = await analyzeBrollOpportunities(
      transcription.text,
      transcription.words || [],
      totalDuration,
      apiKey
    );

    console.log(`[${jobId}]    Found ${opportunities.length} B-roll opportunities`);
    opportunities.forEach((opp, i) => {
      console.log(`[${jobId}]    ${i + 1}. @${opp.timestamp.toFixed(1)}s: "${opp.keyword}" - ${opp.reason}`);
    });

    // Step 3: Generate images for each opportunity
    console.log(`[${jobId}] Step 3: Generating B-roll images...`);
    const brollAssets = [];

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i];
      const assetId = randomUUID();
      const imagePath = join(session.assetsDir, `${assetId}.png`);
      const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

      console.log(`[${jobId}]    [${i + 1}/${opportunities.length}] Generating for "${opp.keyword}"...`);

      const success = await generateImageWithGemini(opp.prompt, apiKey, imagePath);

      if (success && existsSync(imagePath)) {
        // Generate thumbnail
        try {
          await runFFmpeg([
            '-y', '-i', imagePath,
            '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
            '-frames:v', '1',
            thumbPath
          ], jobId);
        } catch (e) {
          console.warn(`[${jobId}]    Thumbnail generation failed:`, e.message);
        }

        const { stat } = await import('fs/promises');
        const stats = await stat(imagePath);
        const info = await getMediaInfo(imagePath);

        // Create asset entry
        const asset = {
          id: assetId,
          type: 'image',
          filename: `broll-${opp.keyword.replace(/\s+/g, '-')}.png`,
          path: imagePath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          duration: 3, // Default 3 seconds for B-roll images
          size: stats.size,
          width: info.width || 1024,
          height: info.height || 1024,
          createdAt: Date.now(),
          // B-roll metadata
          keyword: opp.keyword,
          timestamp: opp.timestamp,
          reason: opp.reason,
        };

        session.assets.set(assetId, asset);
        saveAssetMetadata(session); // Persist asset metadata to disk

        brollAssets.push({
          assetId: asset.id,
          keyword: opp.keyword,
          timestamp: opp.timestamp,
          reason: opp.reason,
          filename: asset.filename,
          thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
        });

        console.log(`[${jobId}]    ✓ Generated: ${asset.filename}`);
      } else {
        console.log(`[${jobId}]    ✗ Failed to generate image for "${opp.keyword}"`);
      }
    }

    console.log(`[${jobId}] Generated ${brollAssets.length}/${opportunities.length} B-roll images`);
    console.log(`[${jobId}] === B-ROLL GENERATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      transcript: transcription.text,
      opportunities: opportunities,
      brollAssets: brollAssets,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== MOTION GRAPHICS RENDERING ==============

// Handle motion graphics rendering
// NOTE: This is a placeholder that creates a simple text overlay video using FFmpeg
// For proper Remotion rendering, you'd need to set up @remotion/renderer with bundling
async function handleRenderMotionGraphic(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { templateId, props, duration, fps = 30, width = 1920, height = 1080 } = body;

    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    console.log(`\n[${jobId}] === RENDER MOTION GRAPHIC ===`);
    console.log(`[${jobId}] Template: ${templateId}`);
    console.log(`[${jobId}] Duration: ${duration}s`);

    // Get text and styling from props
    const text = props.text || props.name || templateId;
    const color = (props.color || props.primaryColor || '#ffffff').replace('#', '');
    const bgColor = props.backgroundColor || '000000';
    const fontSize = props.fontSize || 64;

    // Create a video with text overlay using FFmpeg
    // This is a placeholder - proper Remotion rendering would generate much nicer animations
    const fontFile = '/System/Library/Fonts/Helvetica.ttc'; // macOS system font

    // FFmpeg command to create a video with text
    const ffmpegArgs = [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x${bgColor}:s=${width}x${height}:d=${duration}:r=${fps}`,
      '-vf', `drawtext=text='${text.replace(/'/g, "\\'")}':fontfile=${fontFile}:fontsize=${fontSize}:fontcolor=0x${color}:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      outputPath
    ];

    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry
    const asset = {
      id: assetId,
      type: 'video',
      filename: `motion-${templateId}-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: duration,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      // Metadata
      templateId,
      props,
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${jobId}] Motion graphic rendered: ${assetId}`);
    console.log(`[${jobId}] === RENDER COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Motion graphic render error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// AI-generated animation using Gemini + Remotion
async function handleGenerateAnimation(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { description, videoAssetId, startTime, endTime, attachedAssetIds, fps = 30, width = 1920, height = 1080, durationSeconds } = body;

    if (!description) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'description is required' }));
      return;
    }

    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);

    console.log(`\n[${jobId}] === GENERATE AI ANIMATION ===`);
    console.log(`[${jobId}] Description: ${description}`);
    if (attachedAssetIds?.length) {
      console.log(`[${jobId}] Attached assets: ${attachedAssetIds.length}`);
    }

    // Step 0: Get video transcript context if a video is provided
    let transcriptContext = '';
    let relevantSegment = '';
    let detectedTimeRange = null;

    if (videoAssetId) {
      const videoAsset = session.assets.get(videoAssetId);
      if (videoAsset && videoAsset.type === 'video') {
        console.log(`[${jobId}] Getting transcript context from ${videoAsset.filename}...`);

        try {
          const transcription = await getOrTranscribeVideo(session, videoAsset, jobId);

          if (transcription.text) {
            // If time range provided, get that segment
            if (startTime !== undefined && endTime !== undefined) {
              relevantSegment = getTranscriptSegment(transcription, startTime, endTime);
              detectedTimeRange = { start: startTime, end: endTime };
              console.log(`[${jobId}] ⏱️ Using USER-SPECIFIED time range: ${startTime}s - ${endTime}s`);
              console.log(`[${jobId}] 📝 Extracted transcript segment (${relevantSegment.split(' ').length} words):`);
              console.log(`[${jobId}]    "${relevantSegment.substring(0, 200)}${relevantSegment.length > 200 ? '...' : ''}"`);
            } else {
              // Use AI to identify the relevant part of the video based on the description
              console.log(`[${jobId}] Using AI to identify relevant video segment...`);

              const ai = new GoogleGenAI({ apiKey });
              const segmentResult = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{
                  role: 'user',
                  parts: [{
                    text: `Given this video transcript and an animation request, identify the most relevant time segment.

VIDEO TRANSCRIPT (with word timestamps):
${transcription.words?.slice(0, 200).map(w => `[${w.start.toFixed(1)}s] ${w.text}`).join(' ') || transcription.text.substring(0, 2000)}

ANIMATION REQUEST: "${description}"

VIDEO DURATION: ${videoAsset.duration}s

Analyze the request and determine:
1. Which part of the video is most relevant to this animation
2. The start and end times of the relevant segment

Return ONLY JSON (no markdown):
{
  "startTime": <seconds>,
  "endTime": <seconds>,
  "reasoning": "brief explanation of why this segment is relevant"
}

If the animation seems to be for the intro (beginning), use startTime: 0.
If it's for the outro (ending), use times near the end.
If it's about a specific topic mentioned in the transcript, find where that topic is discussed.
If unclear or general, use the middle third of the video.`
                  }]
                }],
              });

              try {
                const segmentText = segmentResult.candidates[0].content.parts[0].text;
                const cleanedSegment = segmentText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                const segmentData = JSON.parse(cleanedSegment);

                if (segmentData.startTime !== undefined && segmentData.endTime !== undefined) {
                  detectedTimeRange = {
                    start: Math.max(0, segmentData.startTime),
                    end: Math.min(videoAsset.duration, segmentData.endTime)
                  };
                  relevantSegment = getTranscriptSegment(transcription, detectedTimeRange.start, detectedTimeRange.end);
                  console.log(`[${jobId}] AI detected relevant segment: ${detectedTimeRange.start}s - ${detectedTimeRange.end}s`);
                  console.log(`[${jobId}] Reasoning: ${segmentData.reasoning}`);
                }
              } catch (e) {
                console.log(`[${jobId}] Could not parse segment detection, using full transcript`);
                relevantSegment = transcription.text;
              }
            }

            // Build transcript context for the animation prompt
            if (relevantSegment) {
              const timeRangeNote = detectedTimeRange
                ? `\nThis segment is from ${detectedTimeRange.start.toFixed(1)}s to ${detectedTimeRange.end.toFixed(1)}s in the video.`
                : '';

              transcriptContext = `

VIDEO CONTEXT (from the transcript):
"${relevantSegment.substring(0, 1500)}"
${timeRangeNote}

IMPORTANT: The animation content should be relevant to and inspired by this video context. Use specific terms, concepts, and themes from the transcript to make the animation feel connected to the video content.`;

              console.log(`[${jobId}] 🎯 Transcript context built for Gemini (${relevantSegment.length} chars)`);
            }
          }
        } catch (transcriptError) {
          console.log(`[${jobId}] Could not get transcript: ${transcriptError.message}`);
          // Continue without transcript context
        }
      }
    }

    // Build context for attached assets (images/videos to include in animation)
    let attachedAssetsContext = '';
    const attachedAssetPaths = [];
    if (attachedAssetIds?.length) {
      const attachedAssetInfo = [];
      for (const attachedId of attachedAssetIds) {
        const attachedAsset = session.assets.get(attachedId);
        if (attachedAsset) {
          // Build HTTP URL for the asset (served by FFmpeg server)
          const assetUrl = `http://localhost:${PORT}/session/${sessionId}/assets/${attachedAsset.id}/stream`;
          attachedAssetInfo.push({
            id: attachedAsset.id,
            filename: attachedAsset.filename,
            type: attachedAsset.type,
            url: assetUrl,
          });
          attachedAssetPaths.push({
            id: attachedAsset.id,
            path: attachedAsset.path,  // Keep file path for server-side operations
            url: assetUrl,              // HTTP URL for Remotion rendering
            type: attachedAsset.type,
            filename: attachedAsset.filename,
          });
        }
      }
      if (attachedAssetInfo.length > 0) {
        attachedAssetsContext = `

ATTACHED MEDIA ASSETS (MUST be included in the animation):
${attachedAssetInfo.map((a, i) => `Asset ${i + 1}:
  - id: "${a.id}"
  - type: "${a.type}"
  - filename: "${a.filename}"`).join('\n')}

CRITICAL REQUIREMENTS:
1. You MUST create at least one "media" type scene for each attached asset above
2. In each media scene, set "mediaAssetId" to the EXACT id value shown above (copy/paste it exactly)
3. Use "mediaStyle": "framed" for a nicely presented image, or "fullscreen" for dramatic impact
4. Example media scene:
   {
     "id": "show-image",
     "type": "media",
     "duration": 90,
     "content": {
       "title": "Optional title over the image",
       "mediaAssetId": "${attachedAssetInfo[0].id}",
       "mediaStyle": "framed",
       "color": "#f97316"
     }
   }`;
        console.log(`[${jobId}] Including ${attachedAssetInfo.length} attached assets in animation`);
      }
    }

    // Step 1: Use Gemini to generate scene data
    console.log(`[${jobId}] Generating scenes with Gemini...`);

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `You are a motion graphics designer. Create a JSON scene structure for an animated video based on this description:

"${description}"
${transcriptContext}${attachedAssetsContext}
Return ONLY valid JSON (no markdown, no code blocks) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition" | "media" | "chart" | "comparison" | "countdown" | "shapes" | "emoji" | "gif" | "lottie",
      "duration": <number of frames at 30fps, typically 45-90 (1.5-3 seconds per scene). Keep scenes SHORT and punchy!>,
      "content": {
        "title": "optional title text",
        "subtitle": "optional subtitle",
        "items": [{"icon": "emoji or number", "label": "text", "description": "optional", "value": 75, "color": "#hex"}],
        "stats": [{"value": "10K+", "label": "Users", "numericValue": 10000, "prefix": "", "suffix": "+"}],  // IMPORTANT: numericValue must be a NUMBER (not string) for counting animation!
        "color": "#hex color for accent",
        "backgroundColor": "#hex for bg or null for transparent",
        // MEDIA SCENE OPTIONS:
        "mediaAssetId": "id of attached image/video to display",
        "mediaStyle": "fullscreen" | "framed" | "pip" | "background" | "split-left" | "split-right" | "circle" | "phone-frame",
        // VIDEO CONTROLS (for video assets):
        "videoStartFrom": 0,  // frame to start playing from
        "videoEndAt": 90,     // frame to stop at (for trimming)
        "videoVolume": 1,     // 0-1
        "videoPlaybackRate": 1, // 0.5 = slow-mo, 2 = fast forward
        "videoLoop": false,
        "videoMuted": false,
        // MEDIA ANIMATION (ken-burns, zoom, pan on the media itself):
        "mediaAnimation": {"type": "ken-burns" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "parallax", "intensity": 0.3},
        // TEXT OVERLAY ON MEDIA:
        "overlayText": "Text to show over media",
        "overlayPosition": "top" | "center" | "bottom",
        "overlayStyle": "minimal" | "bold" | "gradient-bar",
        // SHAPES SCENE OPTIONS:
        "shapes": [
          {
            "type": "circle" | "rect" | "triangle" | "star" | "polygon" | "ellipse",
            "fill": "#hex color",
            "stroke": "#hex outline color",
            "strokeWidth": 2,
            "x": 50, "y": 50,  // position as percentage (0-100)
            "scale": 1,
            "rotation": 0,
            "delay": 0,  // animation delay in frames
            "animation": "pop" | "spin" | "bounce" | "float" | "pulse" | "none",
            // Shape-specific: radius (circle/polygon), width/height (rect), length/direction (triangle), points/innerRadius/outerRadius (star), rx/ry (ellipse)
          }
        ],
        "shapesLayout": "scattered" | "grid" | "circle" | "custom",
        // EMOJI SCENE OPTIONS:
        "emojis": [
          {
            "emoji": "🔥",  // Use actual emoji characters
            "x": 50, "y": 50,  // position as percentage
            "scale": 0.2,  // size (0.1 = small, 0.3 = large)
            "delay": 0,  // animation delay in frames
            "animation": "pop" | "bounce" | "float" | "pulse" | "spin" | "shake" | "wave" | "none"
          }
        ],
        "emojiLayout": "scattered" | "grid" | "circle" | "row" | "custom",
        // OTHER SCENE OPTIONS:
        "chartType": "bar" | "progress" | "pie",
        "chartData": [{"label": "Category", "value": 75, "color": "#hex"}],
        "maxValue": 100,
        "beforeLabel": "BEFORE", "afterLabel": "AFTER",
        "beforeValue": "50%", "afterValue": "95%",
        "countFrom": 3, "countTo": 0,
        "camera": {"type": "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "ken-burns" | "shake", "intensity": 0.3}
      },
      "transition": {"type": "swipe-left" | "swipe-right" | "swipe-up" | "swipe-down" | "fade" | "zoom-in" | "zoom-out" | "wipe-left" | "wipe-right" | "blur" | "flip", "duration": 15}
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of all scene durations>,
  "attachedAssets": [{"id": "asset-id", "path": "will be filled by server"}]
}

Scene types:
- "title": Big centered title with optional subtitle (for intros/outros)
- "steps": Numbered steps or process flow (1, 2, 3...)
- "features": Feature showcase with icons
- "stats": Animated statistics/numbers with COUNTING animation (numbers count from 0 to target). CRITICAL: You MUST include "numericValue" as an INTEGER (e.g., 10000, not "10000") for the counting animation to work! Example: {"value": "$10K+", "label": "Revenue", "numericValue": 10000, "prefix": "$", "suffix": "+"}. Without numericValue, numbers will NOT animate!
- "text": Simple text message
- "transition": Brief transition between scenes
- "media": Display an attached image/video with ADVANCED controls:
  * mediaStyle: "fullscreen" (edge-to-edge), "framed" (bordered), "pip" (small corner), "background" (dimmed behind text), "split-left"/"split-right" (half screen), "circle" (circular crop), "phone-frame" (mobile mockup)
  * mediaAnimation: Apply ken-burns, zoom, or pan DIRECTLY on the media for dynamic effect
  * overlayText: Add text over the media (great with "background" style)
  * For videos: Use videoStartFrom/videoEndAt to trim, videoPlaybackRate for slow-mo (0.5) or speed-up (2)
- "chart": Data visualization with chartType: "bar" (vertical bars), "progress" (horizontal progress bars), "pie" (pie chart). Use chartData array with label/value/color.
- "comparison": Before/after comparison. Use beforeLabel, afterLabel, beforeValue, afterValue.
- "countdown": Animated countdown. Use countFrom and countTo (e.g., 3 to 0).
- "shapes": Animated SVG shapes scene! Create eye-catching visuals with:
  * Shape types: "circle", "rect", "triangle", "star", "polygon", "ellipse"
  * Animations: "pop" (scale up), "spin" (rotate), "bounce" (vertical movement), "float" (gentle hover), "pulse" (breathing effect)
  * Layout: "scattered" (random positions), "grid" (organized), "circle" (arranged in circle), "custom" (use x/y)
  * Example shapes: [{"type": "star", "fill": "#f97316", "points": 5, "outerRadius": 60, "x": 50, "y": 50, "animation": "spin"}]
- "emoji": Animated emoji scene! Fun and expressive visuals:
  * Use actual emoji characters: "🔥", "⭐", "🚀", "💯", "❤️", "🎉", "✨", "👍", "🎯", "💡", etc.
  * Animations: "pop", "bounce", "float", "pulse", "spin", "shake", "wave"
  * Layout: "scattered", "grid", "circle" (arranged around center), "row" (horizontal line), "custom"
  * Example: [{"emoji": "🔥", "x": 30, "y": 50, "scale": 0.2, "animation": "bounce"}, {"emoji": "🚀", "x": 70, "y": 50, "animation": "float"}]
  * Great for reactions, celebrations, emphasis!
- "gif": Animated GIF scene! GIPHY integration for memes, reactions, and B-roll:
  * Use "gifSearch" to search GIPHY for GIFs by keyword (the server will fetch actual URLs automatically!)
  * Example: {"gifSearch": "mind blown", "gifLayout": "fullscreen"} - searches GIPHY for "mind blown" GIFs
  * Can also use "gifSearches" array for multiple GIFs: {"gifSearches": ["fire", "celebration", "thumbs up"]}
  * Properties for each GIF: x, y (position 0-100), width, height, scale, playbackRate (0.5=slow, 2=fast)
  * Animations: "pop", "bounce", "float", "pulse", "spin", "shake" (applied to the GIF container)
  * Layout: "fullscreen" (single GIF fills screen), "scattered", "grid", "circle", "row", "pip" (corner)
  * Use "gifBackground": true for a looping GIF as the scene background (with dark overlay for readability)
  * POPULAR SEARCHES: "reaction", "funny", "meme", "celebration", "mind blown", "shocked", "laughing", "applause", "fire", "thumbs up", "yes", "no", "thinking", "dancing"
  * Great for: adding humor, emphasizing points, meme-style content, reaction clips!
- "lottie": Professional After Effects animations! Smooth vector animations:
  * Provide Lottie JSON URLs in the "lotties" array (from LottieFiles.com or similar)
  * Properties: src (URL to JSON), x, y (position 0-100), width, height, scale, playbackRate, direction ("forward"/"backward")
  * Layout: "fullscreen", "scattered", "grid", "circle", "row", "custom"
  * Use "lottieBackground" for animated background (with dark overlay)
  * Great for: loading spinners, confetti, celebrations, transitions, icons, illustrations
  * Example: {"lotties": [{"src": "https://assets.lottiefiles.com/...", "width": 400, "height": 400}], "lottieLayout": "fullscreen"}

Camera movement (add to any scene's content):
- "zoom-in": Slowly zoom into the content
- "zoom-out": Start zoomed, pull back
- "pan-left" / "pan-right": Horizontal movement
- "pan-up" / "pan-down": Vertical movement
- "ken-burns": Classic documentary style (slow zoom + slight pan)
- "intensity": 0.1 to 0.5 (subtle to dramatic)

Scene transitions (add to scene to animate entry/exit):
- "swipe-left" / "swipe-right": Slide in/out horizontally (most popular)
- "swipe-up" / "swipe-down": Slide in/out vertically
- "fade": Fade in/out (subtle, professional)
- "zoom-in" / "zoom-out": Scale in/out with fade
- "wipe-left" / "wipe-right": Reveal effect (like a curtain)
- "blur": Blur transition (dreamy effect)
- "flip": 3D flip effect (dramatic)
- "duration": frames for transition (default 15, use 20-30 for dramatic)

Guidelines:
- Use MORE scenes with SHORTER durations (1.5-3 seconds each, 45-90 frames). Fast cuts feel dynamic and engaging!
- For a 5s animation use 3-4 scenes, for 10s use 5-7 scenes, for 15s use 7-10 scenes, for 30s use 12-18 scenes. Scale up proportionally.
- NO scene should exceed 120 frames (4 seconds) unless it's a countdown or media showcase.
- Total duration: ${durationSeconds ? `EXACTLY ${durationSeconds} seconds (${Math.round(durationSeconds * fps)} frames) - the user specifically requested this duration!` : '5-15 seconds (150-450 frames)'}
- Use vibrant colors: #f97316 (orange), #3b82f6 (blue), #22c55e (green), #8b5cf6 (purple), #ec4899 (pink)
- Make it visually engaging with good pacing

IMPORTANT - ADD CAMERA MOVEMENTS to make scenes dynamic:
- ADD "camera" to at least 2-3 scenes (especially title, stats, and media scenes)
- Example: "content": { "title": "Hello", "camera": {"type": "zoom-in", "intensity": 0.25} }
- Use "zoom-in" for focus and impact (intensity 0.2-0.3)
- Use "ken-burns" for media/photos (intensity 0.25-0.35)
- Use "pan-left" or "pan-right" for text reveals (intensity 0.2)
- Use "shake" sparingly for energy (intensity 0.1-0.15)

- When showing numbers/stats, use numericValue for animated counting effect
- ADD TRANSITIONS between scenes! Use "swipe-left" or "swipe-right" for dynamic flow, "fade" for elegance, or "zoom-in" for impact
- Mix transition types for variety (e.g., first scene: swipe-right, second: fade, third: swipe-left)

IMPORTANT - ADD GIF SCENES for humor and engagement:
- ALWAYS include at least 1-2 "gif" type scenes in every animation for comedic/reaction effects!
- Use "gifSearch" with funny, relevant search terms that match the topic (e.g., "mind blown", "excited", "wait what", "money rain", "mic drop")
- Place GIF scenes BETWEEN informational scenes as punchlines or reactions to what was just shown
- Use "gifLayout": "fullscreen" for maximum impact, or "pip" for a subtle corner reaction
- GIFs make animations feel fun, relatable, and meme-worthy - lean into humor!
- Example: After a stats scene showing impressive numbers, add a "gif" scene with "gifSearch": "mind blown" or "impressed"
- For intros, try "lets go" or "hype". For outros, try "mic drop" or "thats all folks"
${attachedAssetIds?.length ? `- IMPORTANT: Include media scenes to showcase the attached images/videos!
- Use "mediaAnimation": {"type": "ken-burns", "intensity": 0.3} to add dynamic movement to images/videos
- Use "background" mediaStyle with "overlayText" for cinematic text-over-video effect
- For product shots, use "phone-frame" or "circle" mediaStyle
- For videos, consider using slow-mo (videoPlaybackRate: 0.5) for dramatic moments` : ''}`;

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    let sceneData;
    try {
      const responseText = result.candidates[0].content.parts[0].text;
      // Clean up response - remove markdown code blocks if present
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      sceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse Gemini response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes`);

    // Log camera movements for debugging
    const scenesWithCamera = sceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    let totalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);

    // Enforce user-requested duration by scaling scene durations proportionally
    if (durationSeconds) {
      const targetFrames = Math.round(durationSeconds * fps);
      if (totalDuration !== targetFrames && totalDuration > 0) {
        const scale = targetFrames / totalDuration;
        console.log(`[${jobId}] ⏱️ Adjusting duration: Gemini gave ${totalDuration} frames (${(totalDuration / fps).toFixed(1)}s), user requested ${durationSeconds}s (${targetFrames} frames). Scale: ${scale.toFixed(2)}x`);
        for (const scene of sceneData.scenes) {
          const oldDuration = scene.duration;
          scene.duration = Math.max(1, Math.round(scene.duration * scale));
          console.log(`[${jobId}]   Scene "${scene.id}": ${oldDuration} → ${scene.duration} frames`);
        }
        totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
        sceneData.totalDuration = totalDuration;
        console.log(`[${jobId}] ⏱️ Adjusted total: ${totalDuration} frames (${(totalDuration / fps).toFixed(1)}s)`);
      }
    }

    const durationInSeconds = totalDuration / fps;

    // Inject actual asset file paths for attached media (use absolute file paths for Remotion CLI)
    if (attachedAssetPaths.length > 0) {
      sceneData.attachedAssets = attachedAssetPaths;
      console.log(`[${jobId}] Available attached assets:`, attachedAssetPaths.map(a => ({ id: a.id, filename: a.filename, type: a.type })));

      // Also update any media scenes with the correct file paths
      let mediaSceneCount = 0;
      for (const scene of sceneData.scenes) {
        console.log(`[${jobId}] Checking scene: type=${scene.type}, hasMediaAssetId=${!!scene.content?.mediaAssetId}`);

        if (scene.type === 'media' && scene.content?.mediaAssetId) {
          const matchedAsset = attachedAssetPaths.find(a => a.id === scene.content.mediaAssetId);
          if (matchedAsset) {
            // Use HTTP URL for Remotion CLI rendering - more reliable than file:// paths
            scene.content.mediaPath = matchedAsset.url;
            scene.content.mediaType = matchedAsset.type;
            mediaSceneCount++;
            console.log(`[${jobId}] ✓ Linked media asset to scene: ${matchedAsset.filename} -> ${matchedAsset.url}`);
          } else {
            console.log(`[${jobId}] ✗ No matching asset found for mediaAssetId: ${scene.content.mediaAssetId}`);
            console.log(`[${jobId}]   Available IDs: ${attachedAssetPaths.map(a => a.id).join(', ')}`);
          }
        } else if (scene.type === 'media' && !scene.content?.mediaAssetId) {
          console.log(`[${jobId}] ✗ Media scene without mediaAssetId - will show placeholder`);
          // If Gemini created a media scene but didn't set mediaAssetId, try to assign the first attached asset
          if (attachedAssetPaths.length > 0) {
            const firstAsset = attachedAssetPaths[0];
            scene.content.mediaAssetId = firstAsset.id;
            scene.content.mediaPath = firstAsset.url;  // Use HTTP URL
            scene.content.mediaType = firstAsset.type;
            mediaSceneCount++;
            console.log(`[${jobId}] ✓ Auto-assigned first attached asset: ${firstAsset.filename} -> ${firstAsset.url}`);
          }
        }
      }

      // If Gemini didn't create any media scenes but we have attached assets, add one
      if (mediaSceneCount === 0 && attachedAssetPaths.length > 0) {
        console.log(`[${jobId}] ⚠ No media scenes found! Adding a media scene for the attached asset(s)`);
        const firstAsset = attachedAssetPaths[0];
        const mediaScene = {
          id: `media-${firstAsset.id}`,
          type: 'media',
          duration: 90, // 3 seconds at 30fps
          content: {
            title: firstAsset.filename.replace(/\.[^/.]+$/, ''), // filename without extension
            mediaAssetId: firstAsset.id,
            mediaPath: firstAsset.url,  // Use HTTP URL
            mediaType: firstAsset.type,
            mediaStyle: 'framed',
            color: '#f97316',
          }
        };
        // Insert media scene near the beginning (after the first scene if there is one)
        if (sceneData.scenes.length > 1) {
          sceneData.scenes.splice(1, 0, mediaScene);
        } else {
          sceneData.scenes.push(mediaScene);
        }
        sceneData.totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
        console.log(`[${jobId}] ✓ Added media scene for: ${firstAsset.filename} -> ${firstAsset.url}`);
      }
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKey = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKey) {
          console.log(`[${jobId}] 🎬 Fetching GIFs from GIPHY for: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifs = await searchGiphy(term, 1);
              if (gifs.length > 0) {
                const gif = gifs[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}": ${gif.title || 'untitled'}`);
                }
              } else {
                console.log(`[${jobId}]    ✗ No GIF found for "${term}"`);
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed for "${term}": ${err.message}`);
            }
          }

          // Set default layout if not specified
          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          } else if (!scene.content.gifLayout) {
            scene.content.gifLayout = 'scattered';
          }

          console.log(`[${jobId}]    Total GIFs fetched: ${scene.content.gifs.length}`);
        } else if (searchTerms.length > 0 && !giphyKey) {
          console.log(`[${jobId}] ⚠ GIPHY_API_KEY not configured - skipping GIF search`);
        }
      }
    }

    // Post-process stats to ensure numericValue is set for counting animation
    for (const scene of sceneData.scenes) {
      if (scene.type === 'stats' && scene.content?.stats) {
        console.log(`[${jobId}] 📊 Processing stats scene with ${scene.content.stats.length} stats...`);
        for (const stat of scene.content.stats) {
          console.log(`[${jobId}]    Raw stat: value="${stat.value}", numericValue=${stat.numericValue} (type: ${typeof stat.numericValue}), prefix="${stat.prefix || ''}", suffix="${stat.suffix || ''}"`);

          // Convert numericValue to number if it's a string
          if (typeof stat.numericValue === 'string') {
            const parsed = parseFloat(stat.numericValue);
            if (!isNaN(parsed)) {
              stat.numericValue = parsed;
              console.log(`[${jobId}]    ✓ Converted string numericValue to number: ${stat.numericValue}`);
            } else {
              stat.numericValue = undefined; // Clear invalid string so we can extract from value
            }
          }

          // If numericValue is not a valid positive number, try to extract from value string
          const hasValidNumericValue = typeof stat.numericValue === 'number' && !isNaN(stat.numericValue) && stat.numericValue > 0;

          if (!hasValidNumericValue && stat.value) {
            const extracted = extractNumericValue(stat.value);
            if (extracted && extracted.numericValue > 0) {
              stat.numericValue = extracted.numericValue;
              stat.prefix = stat.prefix || extracted.prefix;
              stat.suffix = stat.suffix || extracted.suffix;
              console.log(`[${jobId}]    ✓ Extracted: "${stat.value}" → prefix="${stat.prefix}" numericValue=${stat.numericValue} suffix="${stat.suffix}"`);
            } else {
              console.log(`[${jobId}]    ✗ Could not extract numeric value from "${stat.value}"`);
            }
          } else if (hasValidNumericValue) {
            console.log(`[${jobId}]    ✓ Already has valid numericValue: ${stat.numericValue}`);
          }

          // Final check: log what will be used for rendering
          const finalHasNumeric = typeof stat.numericValue === 'number' && !isNaN(stat.numericValue) && stat.numericValue > 0;
          console.log(`[${jobId}]    → Final: numericValue=${stat.numericValue}, will animate: ${finalHasNumeric}`);
        }
      }
    }

    // Step 2: Write props to JSON file for Remotion
    // Log final scene data for debugging
    console.log(`[${jobId}] Final scene data:`);
    for (const scene of sceneData.scenes) {
      const hasMedia = scene.content?.mediaPath ? `mediaPath: ${scene.content.mediaPath}` : 'no media';
      const hasStats = scene.content?.stats ? `stats: ${scene.content.stats.map(s => s.numericValue || s.value).join(', ')}` : '';
      console.log(`[${jobId}]   - ${scene.type}: ${scene.content?.title || '(no title)'} | ${hasMedia} ${hasStats}`);
    }
    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Check if this is a FrameForge style request
    const frameforgeStyleMatch = description.match(/FRAMEFORGE STYLE:\s*([^.]+)/);
    const frameforgeLocations = [
      join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'workspace', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
      join(process.cwd(), '..', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
    ];
    const frameforgeCliPath = frameforgeLocations.find(p => existsSync(p));
    const useFrameForge = frameforgeStyleMatch && frameforgeCliPath;

    if (useFrameForge) {
      // FrameForge rendering path
      const requestedStyle = frameforgeStyleMatch[1].trim();
      console.log(`[${jobId}] Using FrameForge with style: ${requestedStyle}`);

      // Ask Gemini to generate HTML animation with the specified style
      const ai = new GoogleGenAI({ apiKey });
      const htmlResult = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [{
            text: `Create a self-contained HTML animation in the "${requestedStyle}" visual style. This will be rendered to MP4.

CONTENT/TOPIC: ${description.replace(/FRAMEFORGE STYLE:[^.]+\./, '').trim()}
DURATION: ${(totalDuration / fps).toFixed(0)} seconds
SIZE: ${width}x${height}

Write a COMPLETE HTML file. CRITICAL REQUIREMENTS:
- Import Google Font Inter: @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap')
- Set html,body to exactly ${width}px x ${height}px, overflow:hidden, dark background
- ALL animation via requestAnimationFrame + performance.now() ONLY (no CSS @keyframes)
- Helper functions: lerp(a,b,t), ease(t)=1-Math.pow(1-t,3), clamp(val,start,end)=Math.max(0,Math.min(1,(val-start)/(end-start)))
- Text must be LARGE: 48-96px headings, 24-36px body
- Stagger animations with 0.2-0.4s delays
- Keep animating for full duration (add pulsing/floating after initial reveal)
- DO NOT use CSS animation or @keyframes. ONLY JavaScript requestAnimationFrame.
- DO NOT use external libraries.

Visual style "${requestedStyle}" - make it distinctive and professional.

Return ONLY raw HTML starting with <!DOCTYPE html>. No markdown fences.`
          }]
        }],
      });

      let htmlContent = htmlResult.candidates[0].content.parts[0].text;
      htmlContent = htmlContent.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
      if (!htmlContent.startsWith('<!DOCTYPE') && !htmlContent.startsWith('<html')) {
        const htmlMatch = htmlContent.match(/<!DOCTYPE[\s\S]*<\/html>/i) || htmlContent.match(/<html[\s\S]*<\/html>/i);
        if (htmlMatch) htmlContent = htmlMatch[0];
      }

      const htmlPath = join(session.dir, `${assetId}.html`);
      writeFileSync(htmlPath, htmlContent);

      console.log(`[${jobId}] Rendering with FrameForge...`);
      await new Promise((resolve, reject) => {
        const proc = spawn('node', [
          frameforgeCliPath, 'render', htmlPath,
          '--output', outputPath,
          '--duration', String(Math.ceil(totalDuration / fps)),
          '--width', String(width),
          '--height', String(height),
        ], {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GEMINI_API_KEY: apiKey },
        });
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FrameForge render failed: ${stderr.substring(0, 300)}`));
        });
        proc.on('error', (err) => reject(new Error(`Failed to start FrameForge: ${err.message}`)));
      });

      try { unlinkSync(htmlPath); } catch (e) {}
      console.log(`[${jobId}] FrameForge render complete`);

    } else {
      // Standard Remotion rendering path
      console.log(`[${jobId}] Rendering with Remotion...`);

      const remotionArgs = [
        'remotion', 'render',
        'src/remotion/index.tsx',
        'DynamicAnimation',
        outputPath,
        '--props', propsPath,
        '--frames', `0-${totalDuration - 1}`,
        '--fps', String(fps),
        '--width', String(width),
        '--height', String(height),
        '--codec', 'h264',
        '--overwrite',
        '--gl=angle',
      ];

      await new Promise((resolve, reject) => {
        const proc = spawn(NPX_CMD, remotionArgs, {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        });

        let stderr = '';
        proc.stderr.on('data', (data) => {
          stderr += data.toString();
          console.log(`[${jobId}] Remotion: ${data.toString().trim()}`);
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Remotion render failed with code ${code}: ${stderr}`));
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`Failed to start Remotion: ${err.message}`));
        });
      });
    }

    // Step 4: Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Store the scene data for future editing (don't delete props)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    writeFileSync(sceneDataPath, JSON.stringify(sceneData, null, 2));

    // Clean up temporary props file (but keep scene data)
    try {
      unlinkSync(propsPath);
    } catch (e) {
      // Ignore cleanup errors
    }

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry with scene data for re-editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      // Metadata for AI animations
      aiGenerated: true,
      description,
      sceneCount: sceneData.scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] AI animation rendered: ${assetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === GENERATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      sceneCount: sceneData.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('AI animation generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Edit an existing animation with a new prompt
// Takes the original scene data and modifies it based on the prompt
async function handleEditAnimation(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, editPrompt, assets: availableAssets, v1Context, fps = 30, width = 1920, height = 1080 } = body;

    if (!assetId || !editPrompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'assetId and editPrompt are required' }));
      return;
    }

    // Get the original animation asset
    const originalAsset = session.assets.get(assetId);
    if (!originalAsset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Animation asset not found' }));
      return;
    }

    if (!originalAsset.aiGenerated) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset is not an AI-generated animation' }));
      return;
    }

    // Get the original scene data
    let originalSceneData = originalAsset.sceneData;
    if (!originalSceneData && originalAsset.sceneDataPath && existsSync(originalAsset.sceneDataPath)) {
      originalSceneData = JSON.parse(readFileSync(originalAsset.sceneDataPath, 'utf-8'));
    }

    if (!originalSceneData) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Original scene data not found - cannot edit this animation' }));
      return;
    }

    const jobId = randomUUID();
    // IMPORTANT: Reuse the same asset ID to replace in-place (no asset creep)
    const outputPath = originalAsset.path; // Overwrite existing video file
    const thumbPath = originalAsset.thumbPath || join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);
    // Reuse existing scene data path or create one with original asset ID
    const existingSceneDataPath = originalAsset.sceneDataPath || join(session.dir, `${assetId}-scenes.json`);

    console.log(`\n[${jobId}] ========================================`);
    console.log(`[${jobId}] === EDIT AI ANIMATION (IN-PLACE) ===`);
    console.log(`[${jobId}] ========================================`);
    console.log(`[${jobId}] IMPORTANT: Reusing SAME asset ID: ${assetId}`);
    console.log(`[${jobId}] Output path (overwriting): ${outputPath}`);
    console.log(`[${jobId}] Edit prompt: ${editPrompt}`);
    console.log(`[${jobId}] Original scene count: ${originalSceneData.scenes?.length || 0}`);
    console.log(`[${jobId}] Original scenes: ${originalSceneData.scenes?.map(s => s.type).join(', ') || 'none'}`);
    console.log(`[${jobId}] Original scene data being passed to Gemini:`);
    console.log(JSON.stringify(originalSceneData, null, 2));
    if (v1Context) {
      console.log(`[${jobId}] V1 context: ${v1Context.filename} (${v1Context.type})`);
    }

    // Build transcript context from source video if available
    // Try V1 context first, but fall back to any non-AI-generated video in session
    let transcriptContext = '';
    let sourceVideoAsset = null;

    // First, try the V1 clip if it's a real video (not AI-generated animation)
    if (v1Context && v1Context.assetId && v1Context.type === 'video') {
      const v1VideoAsset = session.assets.get(v1Context.assetId);
      if (v1VideoAsset && v1VideoAsset.type === 'video' && !v1VideoAsset.aiGenerated) {
        sourceVideoAsset = v1VideoAsset;
        console.log(`[${jobId}] 📝 Using V1 source video for transcript: ${v1VideoAsset.filename}`);
      }
    }

    // If V1 is an animation, find any source video in the session
    if (!sourceVideoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated) {
          sourceVideoAsset = asset;
          console.log(`[${jobId}] 📝 Using session source video for transcript: ${asset.filename}`);
          break;
        }
      }
    }

    // Fetch transcript from the source video
    if (sourceVideoAsset) {
      try {
        const transcription = await getOrTranscribeVideo(session, sourceVideoAsset, jobId);
        if (transcription.text) {
          // Get first 1500 chars of transcript for context
          const transcriptText = transcription.text.substring(0, 1500);
          transcriptContext = `

VIDEO TRANSCRIPT CONTEXT (what's being said in the video "${sourceVideoAsset.filename}"):
"${transcriptText}"${transcription.text.length > 1500 ? '...' : ''}

This is what the viewer is hearing. Use this context to make the animation content relevant and synchronized with the video's message. Consider:
- Key topics and themes being discussed
- Important words, phrases, or concepts that could be visualized
- The tone and style of the content (educational, entertaining, promotional, etc.)
- Specific facts, numbers, or quotes that could be highlighted`;
          console.log(`[${jobId}] ✅ Transcript context added (${transcriptText.length} chars)`);
        }
      } catch (transcriptError) {
        console.log(`[${jobId}] ⚠️ Could not get transcript: ${transcriptError.message}`);
        // Continue without transcript - not a fatal error
      }
    } else {
      console.log(`[${jobId}] ℹ️ No source video found for transcript context`);
    }

    // Build asset context for Gemini
    let assetContext = '';

    // Include V1 context if provided (primary clip in the edit tab)
    if (v1Context) {
      assetContext += `\n\nPRIMARY V1 CLIP CONTEXT (currently on the timeline):
- ${v1Context.type}: "${v1Context.filename}" (id: ${v1Context.assetId})${v1Context.duration ? `, duration: ${v1Context.duration}s` : ''}
This clip is currently being used in the animation timeline. You can reference it for visual coherence or incorporate it into scenes.`;
    }

    if (availableAssets && availableAssets.length > 0) {
      assetContext += `\n\nAVAILABLE ASSETS you can use in the animation:
${availableAssets.map(a => `- ${a.type}: "${a.filename}" (id: ${a.id})${a.type === 'video' ? `, duration: ${a.duration}s` : ''}`).join('\n')}

To include an asset in a scene, use:
{
  "type": "asset",
  "assetType": "image" | "video",
  "assetId": "<asset id>",
  "duration": <frames>,
  "content": { "title": "optional overlay text" }
}`;
    }

    // Use Gemini to modify the scene data
    console.log(`[${jobId}] Modifying scenes with Gemini...`);

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `You are editing an EXISTING Remotion animation. The user wants to make a SPECIFIC change.

## YOUR TASK
Make ONLY the change the user requested. Do NOT change anything else.

## EXISTING ANIMATION (copy this exactly, then apply ONLY the requested change):
${JSON.stringify(originalSceneData, null, 2)}

## USER'S REQUESTED CHANGE:
"${editPrompt}"
${assetContext}${transcriptContext}

## SCENE STRUCTURE REFERENCE:
Scene types and their content properties:
- "title": { "title": "text", "subtitle": "optional text", "color": "#hex", "backgroundColor": "#hex" }
- "text": { "title": "main text", "subtitle": "optional" }
- "steps" / "features": { "title": "optional heading", "items": [{"icon": "emoji", "label": "text", "description": "optional"}] }
- "stats": { "stats": [{"value": "10K+", "label": "Users", "numericValue": 10000}] }
- "transition": { "color": "#hex" }

## ADDING EMOJIS/ICONS:
To add emojis or icons, use scene types that support "items" array:
{
  "type": "features",
  "duration": 90,
  "content": {
    "title": "Optional heading",
    "items": [
      {"icon": "💯", "label": "100% Satisfaction"},
      {"icon": "🔥", "label": "Hot Feature"},
      {"icon": "⭐", "label": "5-Star Quality"}
    ]
  }
}

To add a SINGLE large emoji/icon, use a "title" scene with the emoji IN the title:
{
  "type": "title",
  "duration": 60,
  "content": {
    "title": "💯",
    "subtitle": "Perfect Score"
  }
}

## CAMERA MOVEMENTS (IMPORTANT - add to make scenes dynamic):
Camera movements make scenes more engaging. Add a "camera" object INSIDE the scene's "content":

Available camera types:
- "zoom-in": Slowly zoom into the content (intensity 0.2-0.4 recommended)
- "zoom-out": Start zoomed in, pull back to reveal
- "pan-left" / "pan-right": Horizontal tracking movement
- "pan-up" / "pan-down": Vertical tilt movement
- "ken-burns": Classic documentary style (slow zoom + subtle pan)
- "shake": Camera shake for energy/impact (use low intensity 0.1-0.2)

EXAMPLE - Complete scene with camera movement:
{
  "id": "intro-scene",
  "type": "title",
  "duration": 90,
  "content": {
    "title": "Welcome",
    "subtitle": "Let's get started",
    "color": "#ffffff",
    "backgroundColor": "#1a1a2e",
    "camera": {
      "type": "zoom-in",
      "intensity": 0.3
    }
  }
}

WHEN TO ADD CAMERA MOVEMENTS:
- User says "add zoom", "zoom in", "zoom effect" → Add camera with type "zoom-in"
- User says "add pan", "pan across", "tracking" → Add camera with type "pan-left" or "pan-right"
- User says "ken burns", "documentary style" → Add camera with type "ken-burns"
- User says "shake", "energy", "impact" → Add camera with type "shake" (low intensity)
- User says "make it dynamic", "more movement", "cinematic" → Add camera movements to multiple scenes

## STRICT RULES - FOLLOW EXACTLY:
1. Copy the ENTIRE existing animation structure above
2. Find ONLY the specific element the user mentioned
3. Change ONLY that element - nothing else
4. Keep ALL other text, colors, durations, and properties EXACTLY the same

## EXAMPLES OF CORRECT BEHAVIOR:
- User says "change the title to Hello World" → Only change the title text field, keep all colors/styles
- User says "make it blue" → Only change color values, keep all text the same
- User says "add a new scene" → Keep all existing scenes, append the new one
- User says "add zoom effect" → Add camera object with zoom-in to relevant scenes
- User says "add ken burns to the intro" → Add camera object to intro scene only
- User says "make it more dynamic" → Add camera movements and/or transitions to scenes
- User says "add a 100 emoji" → Add a new scene with type "title" and title "💯" or add to items array
- User says "add fire emoji" → Add "🔥" to title or items depending on context
- User says "visualize the transcript" → Create scenes that highlight key words, phrases, or concepts from the transcript
- User says "add kinetic typography" → Create animated text scenes using words from the transcript

## TRANSCRIPT VISUALIZATION (if transcript context is provided):
When transcript context is available, you can use it to:
- Extract key quotes and display them with "title" or "text" scenes
- Identify statistics or numbers mentioned and create "stats" scenes
- Find key steps or points and create "steps" or "features" scenes
- Pull important concepts and visualize them with relevant emojis/icons
- Create word clouds or key phrase highlights

## EXAMPLES OF WRONG BEHAVIOR (DO NOT DO THIS):
- Changing colors when user only asked about text
- Changing text when user only asked about colors
- Removing or reordering scenes
- Changing durations unless specifically asked

Return ONLY the complete JSON structure with your minimal change applied. No markdown, no explanation.`;

    // Use Gemini 2.5 Flash for better quota availability
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    let newSceneData;
    try {
      const responseText = result.candidates[0].content.parts[0].text;
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      newSceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse Gemini response:`, parseError);
      throw new Error('Failed to parse AI-modified scene data');
    }

    console.log(`[${jobId}] Modified to ${newSceneData.scenes.length} scenes`);

    // Log camera movements for debugging
    const scenesWithCamera = newSceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    const totalDuration = newSceneData.totalDuration || newSceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = totalDuration / fps;

    // Store scene data for future editing (overwrite existing)
    writeFileSync(existingSceneDataPath, JSON.stringify(newSceneData, null, 2));

    // Write props for Remotion
    writeFileSync(propsPath, JSON.stringify(newSceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Render with Remotion
    console.log(`[${jobId}] Rendering with Remotion...`);

    const remotionArgs = [
      'remotion', 'render',
      'src/remotion/index.tsx',
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${totalDuration - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
      '--gl=angle', // Use Metal GPU acceleration on macOS
    ];

    await new Promise((resolve, reject) => {
      const proc = spawn(NPX_CMD, remotionArgs, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log(`[${jobId}] Remotion: ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Remotion render failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Remotion: ${err.message}`));
      });
    });

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up props file
    try {
      unlinkSync(propsPath);
    } catch (e) {}

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Update the existing asset entry IN-PLACE (no new asset, prevents asset creep)
    originalAsset.duration = durationInSeconds;
    originalAsset.size = stats.size;
    originalAsset.thumbPath = existsSync(thumbPath) ? thumbPath : null;
    originalAsset.sceneCount = newSceneData.scenes.length;
    originalAsset.sceneDataPath = existingSceneDataPath;
    originalAsset.sceneData = newSceneData;
    originalAsset.lastEditedAt = Date.now();
    originalAsset.lastEditPrompt = editPrompt;
    // Keep original description but track edit history
    originalAsset.editCount = (originalAsset.editCount || 0) + 1;
    saveAssetMetadata(session); // Persist updated metadata to disk

    console.log(`[${jobId}] ========================================`);
    console.log(`[${jobId}] Animation updated IN-PLACE successfully!`);
    console.log(`[${jobId}] SAME asset ID: ${assetId}`);
    console.log(`[${jobId}] Duration: ${durationInSeconds}s`);
    console.log(`[${jobId}] Edit count: ${originalAsset.editCount}`);
    console.log(`[${jobId}] Total assets in session: ${session.assets.size}`);
    console.log(`[${jobId}] === EDIT COMPLETE ===`);
    console.log(`[${jobId}] ========================================\n`);

    const responseData = {
      success: true,
      assetId: assetId, // Same asset ID - no new asset created
      filename: originalAsset.filename,
      duration: durationInSeconds,
      sceneCount: newSceneData.scenes.length,
      editCount: originalAsset.editCount,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail?t=${Date.now()}`, // Cache bust
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream?t=${Date.now()}`, // Cache bust
    };

    console.log(`[${jobId}] Sending response:`, JSON.stringify(responseData, null, 2));

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(responseData));

  } catch (error) {
    console.error('Animation edit error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate image using fal.ai nano-banana-pro model (Picasso agent)
async function handleGenerateImage(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;

  try {
    const body = await parseBody(req);
    const {
      prompt,
      aspectRatio = '16:9',
      resolution = '1K',
      numImages = 1
    } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === PICASSO: GENERATE IMAGE ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Aspect ratio: ${aspectRatio}, Resolution: ${resolution}`);

    // Enhance prompt using Gemini for better image generation results
    let enhancedPrompt = prompt;
    if (geminiApiKey) {
      try {
        console.log(`[${jobId}] Enhancing prompt with Picasso AI...`);
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        const systemPrompt = `You are Picasso, an expert AI prompt engineer specializing in image generation. Your role is to transform simple user requests into detailed, visually compelling prompts that produce stunning images.

## Your Expertise
- Deep knowledge of photography, cinematography, art styles, and visual composition
- Understanding of lighting (golden hour, studio, dramatic, soft, etc.)
- Mastery of artistic movements (impressionism, surrealism, photorealism, etc.)
- Knowledge of camera perspectives, lenses, and depth of field
- Understanding of color theory and mood creation

## Prompt Enhancement Guidelines

1. **Visual Details**: Add specific visual elements - textures, materials, colors, patterns
2. **Lighting**: Specify lighting conditions that enhance the mood (soft diffused light, dramatic rim lighting, golden hour glow, neon accents)
3. **Composition**: Include framing, perspective, and focal points (close-up, wide shot, bird's eye view, rule of thirds)
4. **Style**: Add artistic style when appropriate (cinematic, photorealistic, digital art, oil painting, etc.)
5. **Atmosphere**: Include mood and atmosphere descriptors (ethereal, moody, vibrant, serene, dynamic)
6. **Quality Markers**: Add quality enhancers (highly detailed, 8K, professional photography, masterpiece)

## Rules
- Keep the enhanced prompt under 200 words
- Preserve the user's core intent - don't change WHAT they want, enhance HOW it looks
- Don't add text/words to appear in the image unless requested
- Output ONLY the enhanced prompt, no explanations or markdown
- Make every image feel premium, professional, and visually striking

## Examples

User: "a cat sitting on a windowsill"
Enhanced: "A majestic tabby cat lounging on a sun-drenched windowsill, soft golden hour light streaming through sheer curtains, dust particles floating in the warm light beams, cozy interior with potted plants, shallow depth of field, photorealistic, intimate portrait style, warm amber and cream color palette, highly detailed fur texture"

User: "cyberpunk city"
Enhanced: "Sprawling cyberpunk metropolis at night, towering neon-lit skyscrapers piercing through low-hanging smog, holographic advertisements reflecting off rain-slicked streets, flying vehicles with glowing thrusters, diverse crowd of augmented humans, pink and cyan neon color scheme, cinematic wide-angle shot, blade runner aesthetic, volumetric fog, raytraced reflections, 8K ultra detailed"

User: "a peaceful forest"
Enhanced: "Ancient moss-covered forest with towering redwood trees, ethereal morning mist weaving between massive trunks, soft dappled sunlight filtering through the dense canopy, ferns and wildflowers carpeting the forest floor, a gentle stream with crystal-clear water, mystical and serene atmosphere, nature photography style, rich greens and earth tones, depth and scale, photorealistic, National Geographic quality"`;

        const result = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{
            role: 'user',
            parts: [{ text: `Enhance this image prompt:\n\n"${prompt}"` }]
          }],
          systemInstruction: systemPrompt,
        });

        const enhanced = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (enhanced && enhanced.length > 10) {
          enhancedPrompt = enhanced;
          console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
        }
      } catch (enhanceError) {
        console.warn(`[${jobId}] Prompt enhancement failed, using original:`, enhanceError.message);
      }
    } else {
      console.log(`[${jobId}] No GEMINI_API_KEY, using original prompt`);
    }

    // Call fal.ai nano-banana-pro API with enhanced prompt
    console.log(`[${jobId}] Sending to fal.ai...`);
    const falResult = await fal.run('fal-ai/nano-banana-pro', {
      input: {
        prompt: enhancedPrompt,
        num_images: Math.min(numImages, 4),
        aspect_ratio: aspectRatio,
        resolution,
        output_format: 'png',
      },
    });
    console.log(`[${jobId}] Generated ${falResult.data?.images?.length || 0} images`);

    // SDK returns { data, requestId }
    const images = falResult.data?.images;
    if (!images || images.length === 0) {
      throw new Error('No images generated');
    }

    // Download and save each generated image as an asset
    const generatedAssets = [];

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const imageId = randomUUID();
      const imagePath = join(session.assetsDir, `${imageId}.png`);
      const thumbPath = join(session.assetsDir, `${imageId}_thumb.jpg`);

      console.log(`[${jobId}] Downloading image ${i + 1}...`);

      // Download image
      const imageResponse = await fetch(imageData.url);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status}`);
      }

      const buffer = await imageResponse.arrayBuffer();
      writeFileSync(imagePath, Buffer.from(buffer));

      // Generate thumbnail
      try {
        await runFFmpeg([
          '-y', '-i', imagePath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);
      } catch (e) {
        console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
      }

      const { stat } = await import('fs/promises');
      const stats = await stat(imagePath);

      // Create short filename from prompt
      const shortPrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-');

      const asset = {
        id: imageId,
        type: 'image',
        filename: `picasso-${shortPrompt}.png`,
        path: imagePath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: 5, // Default 5 seconds for images on timeline
        size: stats.size,
        width: imageData.width || 1024,
        height: imageData.height || 1024,
        createdAt: Date.now(),
        aiGenerated: true,
        generatedBy: 'picasso',
        prompt: prompt, // Original user prompt
        enhancedPrompt: enhancedPrompt !== prompt ? enhancedPrompt : undefined, // Enhanced prompt if different
      };

      session.assets.set(imageId, asset);
      generatedAssets.push({
        id: imageId,
        filename: asset.filename,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: `/session/${sessionId}/assets/${imageId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${imageId}/stream`,
      });

      console.log(`[${jobId}] Saved image: ${asset.filename} (${(stats.size / 1024).toFixed(1)} KB)`);
    }

    saveAssetMetadata(session); // Persist asset metadata to disk
    console.log(`[${jobId}] === PICASSO COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      images: generatedAssets,
      description: falResult.description,
    }));

  } catch (error) {
    console.error('Image generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate video from image using fal.ai (DiCaprio agent)
async function handleGenerateVideo(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;

  try {
    const body = await parseBody(req);
    const { prompt, imageAssetId, duration = 5 } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    if (!imageAssetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'imageAssetId is required' }));
      return;
    }

    // Get the source image asset
    const imageAsset = session.assets.get(imageAssetId);
    if (!imageAsset || imageAsset.type !== 'image') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Image asset not found' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: GENERATE VIDEO ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Source image: ${imageAsset.filename}`);
    console.log(`[${jobId}] Duration: ${duration}s`);

    // Enhance prompt using Gemini for better video generation
    let enhancedPrompt = prompt;
    if (geminiApiKey) {
      try {
        console.log(`[${jobId}] Enhancing prompt with DiCaprio AI...`);
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        const systemPrompt = `You are DiCaprio, an expert AI prompt engineer specializing in image-to-video generation. Your role is to transform simple motion requests into detailed, cinematic prompts that produce stunning videos.

## Your Expertise
- Deep knowledge of cinematography, camera movements, and film techniques
- Understanding of timing, pacing, and motion dynamics
- Mastery of visual storytelling through movement
- Knowledge of video generation model capabilities

## Prompt Enhancement Guidelines

1. **Camera Movement**: Be specific about camera motion (dolly, pan, tilt, zoom, crane, tracking, handheld)
2. **Motion Direction**: Specify direction and speed (slow zoom in, gentle pan left, dynamic push forward)
3. **Subject Motion**: Describe how elements in the scene should move (hair flowing, leaves rustling, water rippling)
4. **Atmosphere**: Include atmospheric effects (light rays moving, dust particles, fog drifting)
5. **Timing**: Use terms like "gradual", "sudden", "rhythmic", "smooth", "cinematic"

## Response Format
Return ONLY the enhanced prompt text. No explanations, no quotes, no markdown.

## Example Input -> Output
Input: "make it move"
Output: "Cinematic slow zoom in with subtle parallax movement, gentle ambient motion with soft light rays drifting through the scene, atmospheric particles floating in the air, smooth and dreamlike camera drift"

Input: "zoom out"
Output: "Epic reveal shot with slow cinematic zoom out, camera gently pulling back to reveal the full scene, subtle atmospheric haze and soft light flares, smooth dolly movement with slight vertical lift"`;

        const result = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'user', parts: [{ text: `Enhance this video motion prompt: "${prompt}"` }] }
          ],
        });

        enhancedPrompt = result.candidates[0].content.parts[0].text.trim();
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      } catch (e) {
        console.log(`[${jobId}] Prompt enhancement failed, using original: ${e.message}`);
      }
    }

    // Upload image to fal.ai storage to get a URL (handles large files)
    console.log(`[${jobId}] Uploading image to fal.ai storage...`);
    const imageBuffer = readFileSync(imageAsset.path);
    const mimeType = imageAsset.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const imageBlob = new Blob([imageBuffer], { type: mimeType });
    const uploadedImageUrl = await fal.storage.upload(imageBlob);
    console.log(`[${jobId}] Image uploaded: ${uploadedImageUrl.substring(0, 50)}...`);

    console.log(`[${jobId}] Calling fal.ai video generation...`);

    // Use fal.ai SDK with automatic queue handling
    const falResult = await fal.subscribe('fal-ai/kling-video/v1.5/pro/image-to-video', {
      input: {
        prompt: enhancedPrompt,
        image_url: uploadedImageUrl,
        duration: duration === 10 ? '10' : '5',
        aspect_ratio: '16:9',
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') {
          console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
        } else if (update.status === 'IN_PROGRESS') {
          console.log(`[${jobId}] Processing...`);
        }
      },
    });

    console.log(`[${jobId}] Video generation complete!`);

    // Download the generated video - SDK returns { data, requestId }
    const videoUrl = falResult.data?.video?.url;
    if (!videoUrl) {
      throw new Error('No video URL in response');
    }

    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new Error('Failed to download generated video');
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Save to assets
    const videoId = randomUUID();
    const shortPrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const videoPath = join(session.assetsDir, `${videoId}.mp4`);
    const thumbPath = join(session.assetsDir, `${videoId}_thumb.jpg`);

    writeFileSync(videoPath, videoBuffer);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video duration using ffprobe
    let videoDuration = duration;
    try {
      const probeResult = await new Promise((resolve, reject) => {
        const proc = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'json',
          videoPath
        ]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.on('close', code => {
          if (code === 0) {
            try {
              const data = JSON.parse(output);
              resolve(parseFloat(data.format.duration) || duration);
            } catch { resolve(duration); }
          } else {
            resolve(duration);
          }
        });
        proc.on('error', () => resolve(duration));
      });
      videoDuration = probeResult;
    } catch (e) {
      console.log(`[${jobId}] Could not probe video duration, using default`);
    }

    const { stat } = await import('fs/promises');
    const stats = await stat(videoPath);

    // Create asset entry
    const asset = {
      id: videoId,
      filename: `dicaprio-${shortPrompt}.mp4`,
      originalFilename: `dicaprio-${shortPrompt}.mp4`,
      type: 'video',
      path: videoPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: 1920,
      height: 1080,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio',
      sourcePrompt: prompt,
      enhancedPrompt: enhancedPrompt,
      sourceImageId: imageAssetId,
    };

    session.assets.set(videoId, asset);
    saveAssetMetadata(session);

    console.log(`[${jobId}] Saved video: ${asset.filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`[${jobId}] === DICAPRIO COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      video: {
        id: videoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${videoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${videoId}/stream`,
        duration: videoDuration,
      },
    }));

  } catch (error) {
    console.error('Video generation error:', error);
    console.error('Error stack:', error.stack);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Restyle video using LTX-2 video-to-video (DiCaprio agent)
async function handleRestyleVideo(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;

  try {
    const body = await parseBody(req);
    const { prompt, videoAssetId } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    if (!videoAssetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'videoAssetId is required' }));
      return;
    }

    // Get the source video asset
    const videoAsset = session.assets.get(videoAssetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Video asset not found' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: RESTYLE VIDEO ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Enhance prompt using Gemini for better style transfer
    let enhancedPrompt = prompt;
    if (geminiApiKey) {
      try {
        console.log(`[${jobId}] Enhancing style prompt with AI...`);
        const ai = new GoogleGenAI({ apiKey: geminiApiKey });

        const result = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{
            role: 'user',
            parts: [{
              text: `You are an expert at writing prompts for AI video style transfer. Transform this simple style request into a detailed, cinematic prompt that will produce stunning results.

User request: "${prompt}"

Write a detailed prompt describing the visual style. Include:
- Color grading and mood
- Texture and grain quality
- Lighting style
- Overall aesthetic
- Any specific visual effects

Return ONLY the enhanced prompt, no explanations.`
            }]
          }],
        });

        enhancedPrompt = result.candidates[0].content.parts[0].text.trim();
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      } catch (e) {
        console.log(`[${jobId}] Prompt enhancement failed, using original: ${e.message}`);
      }
    }

    // Compress video for upload (fal.ai has size limits)
    const compressedPath = join(TEMP_DIR, `${jobId}-compressed.mp4`);
    console.log(`[${jobId}] Compressing video for upload...`);

    // Compress to 720p max, lower bitrate for faster upload
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vf', 'scale=-2:720',  // Max 720p height, maintain aspect
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',  // Lower quality but smaller file
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', '10',  // Max 10 seconds for API limits
      compressedPath
    ], jobId);

    // Upload compressed video to fal.ai storage
    console.log(`[${jobId}] Uploading compressed video to fal.ai storage...`);
    const videoBuffer = readFileSync(compressedPath);
    const fileSizeMB = videoBuffer.length / (1024 * 1024);
    console.log(`[${jobId}] Compressed size: ${fileSizeMB.toFixed(1)} MB`);

    const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });
    const uploadedVideoUrl = await fal.storage.upload(videoBlob);
    console.log(`[${jobId}] Video uploaded: ${uploadedVideoUrl.substring(0, 50)}...`);

    // Clean up compressed file
    try { unlinkSync(compressedPath); } catch (e) {}

    console.log(`[${jobId}] Calling fal.ai LTX-2 video-to-video...`);

    // Use fal.ai SDK with automatic queue handling
    const falResult = await fal.subscribe('fal-ai/ltx-2-19b/video-to-video', {
      input: {
        prompt: enhancedPrompt,
        video_url: uploadedVideoUrl,
        num_inference_steps: 40,
        guidance_scale: 3,
        video_strength: 0.7,
        generate_audio: false,
        video_quality: 'high',
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') {
          console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
        } else if (update.status === 'IN_PROGRESS') {
          console.log(`[${jobId}] Processing...`);
        }
      },
    });

    console.log(`[${jobId}] Video restyle complete!`);

    // Download the restyled video - SDK returns { data, requestId }
    const outputVideoUrl = falResult.data?.video?.url;
    if (!outputVideoUrl) {
      throw new Error('No video URL in response');
    }

    const videoResponse = await fetch(outputVideoUrl);
    if (!videoResponse.ok) {
      throw new Error('Failed to download restyled video');
    }

    const outputBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Save to assets
    const newVideoId = randomUUID();
    const shortPrompt = prompt.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const outputPath = join(session.assetsDir, `${newVideoId}.mp4`);
    const thumbPath = join(session.assetsDir, `${newVideoId}_thumb.jpg`);

    writeFileSync(outputPath, outputBuffer);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video duration
    let videoDuration = videoAsset.duration || 5;
    try {
      const probeResult = await new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputPath]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.on('close', code => {
          if (code === 0) {
            try { resolve(parseFloat(JSON.parse(output).format.duration)); }
            catch { resolve(videoDuration); }
          } else resolve(videoDuration);
        });
        proc.on('error', () => resolve(videoDuration));
      });
      videoDuration = probeResult;
    } catch (e) { /* use default */ }

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    const asset = {
      id: newVideoId,
      filename: `restyled-${shortPrompt}.mp4`,
      originalFilename: `restyled-${shortPrompt}.mp4`,
      type: 'video',
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: falResult.video?.width || 1280,
      height: falResult.video?.height || 720,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio-restyle',
      sourcePrompt: prompt,
      sourceVideoId: videoAssetId,
    };

    session.assets.set(newVideoId, asset);
    saveAssetMetadata(session);

    console.log(`[${jobId}] Saved restyled video: ${asset.filename}`);
    console.log(`[${jobId}] === DICAPRIO RESTYLE COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      video: {
        id: newVideoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${newVideoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${newVideoId}/stream`,
        duration: videoDuration,
      },
    }));

  } catch (error) {
    console.error('Video restyle error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Remove video background using Bria (DiCaprio agent)
async function handleRemoveVideoBg(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { videoAssetId } = body;

    if (!videoAssetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'videoAssetId is required' }));
      return;
    }

    // Get the source video asset
    const videoAsset = session.assets.get(videoAssetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Video asset not found' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: REMOVE VIDEO BACKGROUND ===`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Compress video for upload (fal.ai has size limits)
    const compressedPath = join(TEMP_DIR, `${jobId}-bg-compressed.mp4`);
    console.log(`[${jobId}] Compressing video for upload...`);

    // Compress to 720p max, lower bitrate for faster upload
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vf', 'scale=-2:720',  // Max 720p height, maintain aspect
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',  // Lower quality but smaller file
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', '10',  // Max 10 seconds for API limits
      compressedPath
    ], jobId);

    // Upload compressed video to fal.ai storage
    console.log(`[${jobId}] Uploading compressed video to fal.ai storage...`);
    const videoBuffer = readFileSync(compressedPath);
    const fileSizeMB = videoBuffer.length / (1024 * 1024);
    console.log(`[${jobId}] Compressed size: ${fileSizeMB.toFixed(1)} MB`);

    const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });
    const uploadedVideoUrl = await fal.storage.upload(videoBlob);
    console.log(`[${jobId}] Video uploaded: ${uploadedVideoUrl.substring(0, 50)}...`);

    // Clean up compressed file
    try { unlinkSync(compressedPath); } catch (e) {}

    console.log(`[${jobId}] Calling fal.ai Bria video background removal...`);

    // Use fal.ai SDK with automatic queue handling
    const falResult = await fal.subscribe('fal-ai/ben/v2/video', {
      input: {
        video_url: uploadedVideoUrl,
        output_format: 'webm',  // WebM for transparency support
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') {
          console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
        } else if (update.status === 'IN_PROGRESS') {
          console.log(`[${jobId}] Processing...`);
        }
      },
    });

    console.log(`[${jobId}] Background removal complete!`);

    // Download the processed video - SDK returns { data, requestId }
    const outputVideoUrl = falResult.data?.video?.url;
    if (!outputVideoUrl) {
      throw new Error('No video URL in response');
    }

    const videoResponse = await fetch(outputVideoUrl);
    if (!videoResponse.ok) {
      throw new Error('Failed to download processed video');
    }

    const outputBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Save to assets (webm for transparency support)
    const newVideoId = randomUUID();
    const baseName = videoAsset.filename.replace(/\.[^/.]+$/, '');
    const outputPath = join(session.assetsDir, `${newVideoId}.webm`);
    const thumbPath = join(session.assetsDir, `${newVideoId}_thumb.jpg`);

    writeFileSync(outputPath, outputBuffer);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video duration
    let videoDuration = videoAsset.duration || 5;
    try {
      const probeResult = await new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputPath]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.on('close', code => {
          if (code === 0) {
            try { resolve(parseFloat(JSON.parse(output).format.duration)); }
            catch { resolve(videoDuration); }
          } else resolve(videoDuration);
        });
        proc.on('error', () => resolve(videoDuration));
      });
      videoDuration = probeResult;
    } catch (e) { /* use default */ }

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    const asset = {
      id: newVideoId,
      filename: `${baseName}-nobg.webm`,
      originalFilename: `${baseName}-nobg.webm`,
      type: 'video',
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: videoAsset.width || 1920,
      height: videoAsset.height || 1080,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio-remove-bg',
      sourceVideoId: videoAssetId,
      hasTransparency: true,
    };

    session.assets.set(newVideoId, asset);
    saveAssetMetadata(session);

    console.log(`[${jobId}] Saved video: ${asset.filename}`);
    console.log(`[${jobId}] === DICAPRIO REMOVE BG COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      video: {
        id: newVideoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${newVideoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${newVideoId}/stream`,
        duration: videoDuration,
      },
    }));

  } catch (error) {
    console.error('Video background removal error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate batch animations across the timeline based on video content analysis
async function handleGenerateBatchAnimations(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { count = 5, fps = 30, width = 1920, height = 1080, forcedPlan } = body;

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE BATCH ANIMATIONS ===`);
    console.log(`[${jobId}] Requested count: ${count}${forcedPlan ? ' (forced plan provided)' : ''}`);

    // Find the first video asset in the session
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename} (${videoAsset.duration}s)`);

    // If a forced plan is provided, skip transcription and planning
    let animationPlan;
    if (forcedPlan) {
      console.log(`[${jobId}] Using forced plan - skipping transcription and planning`);
      animationPlan = forcedPlan;
    }

    let transcription = { text: '', words: [] };
    if (!forcedPlan) {
      // Step 1: Get or create transcription
      console.log(`[${jobId}] Step 1: Getting video transcription...`);
      transcription = await getOrTranscribeVideo(session, videoAsset, jobId);

      if (!transcription.text) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Could not transcribe video' }));
        return;
      }

      console.log(`[${jobId}] Transcription: ${transcription.text.substring(0, 200)}...`);
    }

    // Step 2: Use Gemini to plan animations across the video
    if (!forcedPlan) {
      console.log(`[${jobId}] Step 2: Planning ${count} animations with AI...`);

    // Build transcript intelligence for smarter placement
    const words = transcription.words || [];
    let intelligenceBlock = '';
    if (words.length > 0) {
      // Detect emphasis moments (short punchy phrases after pauses)
      const emphasisMoments = [];
      const phrases = [];
      let currentPhrase = [];
      for (let i = 0; i < words.length; i++) {
        currentPhrase.push(words[i]);
        const isLast = i === words.length - 1;
        const nextWord = isLast ? null : words[i + 1];
        const gap = nextWord ? nextWord.start - words[i].end : 1;
        if (gap > 0.5 || isLast) {
          const text = currentPhrase.map(w => w.text).join(' ');
          const startMs = Math.round(currentPhrase[0].start * 1000);
          const endMs = Math.round(currentPhrase[currentPhrase.length - 1].end * 1000);
          phrases.push({ text, startMs, endMs });
          if (currentPhrase.length <= 4 && currentPhrase.length >= 1) {
            emphasisMoments.push({ text, time: currentPhrase[0].start.toFixed(1) });
          }
          currentPhrase = [];
        }
      }

      // Detect stats
      const statMoments = [];
      for (const p of phrases) {
        if (/\$[\d,.]+|\d+%|\d+x\b|\b\d{3,}\b/.test(p.text)) {
          statMoments.push({ text: p.text, time: (p.startMs / 1000).toFixed(1) });
        }
      }

      // Detect topic transitions (pauses > 1.5s)
      const transitions = [];
      for (let i = 0; i < words.length - 1; i++) {
        const gap = words[i + 1].start - words[i].end;
        if (gap > 1.5) {
          const nextPhrase = phrases.find(p => p.startMs >= words[i + 1].start * 1000);
          if (nextPhrase) {
            transitions.push({ time: words[i + 1].start.toFixed(1), text: nextPhrase.text.substring(0, 50) });
          }
        }
      }

      intelligenceBlock = `
TRANSCRIPT INTELLIGENCE (use this for smarter placement):

Key emphasis moments (short punchy phrases — great for text overlays):
${emphasisMoments.slice(0, 10).map(e => `  [${e.time}s] "${e.text}"`).join('\n')}

Stats/numbers mentioned (great for animated stat callouts):
${statMoments.length > 0 ? statMoments.slice(0, 5).map(s => `  [${s.time}s] "${s.text}"`).join('\n') : '  None detected'}

Topic transitions (great for chapter markers or transition effects):
${transitions.slice(0, 8).map(t => `  [${t.time}s] "${t.text}"`).join('\n')}

IMPORTANT: Place animations AT these detected moments, not at random timestamps. These are the moments where overlays will have the most impact.
`;
    }

    const ai = new GoogleGenAI({ apiKey });
    const planResult = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{
          text: `You are a video editor planning motion graphics animations for a video. Analyze this transcript and plan exactly ${count} animations that would enhance the video.

VIDEO TRANSCRIPT:
"${transcription.text}"

VIDEO DURATION: ${videoAsset.duration} seconds

WORD TIMESTAMPS (for timing reference):
${transcription.words?.slice(0, 100).map(w => `[${w.start.toFixed(1)}s] ${w.text}`).join(' ') || 'Not available'}
${intelligenceBlock}
Plan exactly ${count} animations. Each should:
1. Be placed at a strategic moment in the video (intro, key points, transitions, outro)
2. Have a specific purpose (introduce topic, highlight key point, transition, call-to-action, etc.)
3. Be relevant to the content being discussed at that timestamp

Return ONLY valid JSON (no markdown):
{
  "animations": [
    {
      "type": "intro" | "highlight" | "transition" | "callout" | "outro",
      "startTime": <seconds where animation should appear>,
      "duration": <animation duration in seconds, typically 3-5>,
      "title": "<short title for the animation>",
      "description": "<detailed description of what the animation should show, including specific text, colors, style>",
      "relevantContent": "<what the video is discussing at this point>"
    }
  ]
}

Guidelines:
- First animation should typically be an intro (startTime: 0)
- Last animation could be an outro or call-to-action
- Space animations throughout the video, not clustered together
- Each animation should enhance understanding or engagement
- Be specific about visual style, colors, and text content
- Use the transcript intelligence data above to place animations at the most impactful moments`
        }]
      }],
    });

    // Close the planning block (only runs when no forcedPlan)
    try {
      const planText = planResult.candidates[0].content.parts[0].text;
      const cleanedPlan = planText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      animationPlan = JSON.parse(cleanedPlan);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse animation plan:`, parseError);
      throw new Error('Failed to parse AI animation plan');
    }
    } // end if (!forcedPlan)

    console.log(`[${jobId}] Planned ${animationPlan.animations.length} animations`);
    animationPlan.animations.forEach((a, i) => {
      console.log(`[${jobId}]   ${i + 1}. ${a.type} at ${a.startTime}s: ${a.title}`);
    });

    // Step 3: Generate each animation
    console.log(`[${jobId}] Step 3: Generating animations...`);
    const generatedAnimations = [];

    for (let i = 0; i < animationPlan.animations.length; i++) {
      const plan = animationPlan.animations[i];
      console.log(`[${jobId}] Generating animation ${i + 1}/${animationPlan.animations.length}: ${plan.title}`);

      const assetId = randomUUID();
      const outputPath = join(session.assetsDir, `${assetId}.mp4`);
      const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
      const propsPath = join(session.dir, `${jobId}-batch-${i}-props.json`);
      const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);

      // Pick a unique visual style for each animation to ensure variety
      const VISUAL_STYLES = [
        {
          name: 'Neon Glow',
          desc: 'Dark background with neon glowing text and borders. Colors: cyan #00f0ff, magenta #ff00ff, electric blue #0066ff. Text has text-shadow glow effects (0 0 20px color). Thin neon border lines that pulse. Subtle grid pattern background.',
          bg: '#050510',
        },
        {
          name: 'Glassmorphism',
          desc: 'Frosted glass panels with backdrop-filter: blur(20px). Semi-transparent white backgrounds (rgba(255,255,255,0.08)). Subtle white borders (rgba(255,255,255,0.15)). Soft shadows. Content floats in from different directions. Gradient accent line.',
          bg: '#0f0f1a',
        },
        {
          name: 'Bold Typography',
          desc: 'Massive bold text (100-200px) that fills the screen. Words animate in one by one with scale + rotation. Mix of font weights (400 and 900). Accent color backgrounds behind key words. Minimal - just text, no boxes or panels.',
          bg: '#0a0a0a',
        },
        {
          name: 'Data Dashboard',
          desc: 'Animated charts, progress bars, and counters. Numbers count up from 0 to target. Horizontal bars that grow. Circular progress rings using SVG. Clean grid layout with labeled metrics. Monospace numbers.',
          bg: '#0d1117',
        },
        {
          name: 'Split Reveal',
          desc: 'Screen splits into 2-3 columns or rows that slide in from edges. Each section has different content. Diagonal dividers using clip-path. Bold color blocks (indigo, amber, emerald). Content staggers in per section.',
          bg: '#0a0a0a',
        },
        {
          name: 'Particle Burst',
          desc: 'Central text with animated dots/circles that radiate outward. Use multiple small div elements animated with CSS transforms. Particles have different sizes, speeds, and opacity. Creates energy/excitement feel. Starburst effect.',
          bg: '#080818',
        },
        {
          name: 'Kinetic Stack',
          desc: 'Multiple text lines that stack vertically, each sliding in from alternating sides (left, right, left). Different font sizes creating visual hierarchy. Lines have colored underlines or highlights that wipe in. Bottom-to-top build.',
          bg: '#0a0a0a',
        },
        {
          name: 'Spotlight Focus',
          desc: 'Dark background with a circular radial gradient spotlight that moves or pulses. Main text in the spotlight. Secondary text fades in around it. Dramatic, cinematic feel. Use radial-gradient for the spotlight effect.',
          bg: '#050505',
        },
        {
          name: 'Gradient Wave',
          desc: 'Animated gradient backgrounds that shift colors. Text has gradient fill using background-clip: text. Wavy underlines or decorative elements. Smooth color transitions. Vibrant: orange to pink to purple.',
          bg: '#0a0a0a',
        },
        {
          name: 'Card Flip',
          desc: 'Content presented on cards that flip, rotate, or slide into position. Cards have rounded corners, subtle borders, and inner shadows. Information organized in card grid. Each card animates in with a bounce effect.',
          bg: '#0f0f1a',
        },
        {
          name: 'Typewriter Terminal',
          desc: 'Green monospace text on black, like a hacking terminal. Text types out character by character. Blinking cursor. Scanline effect using repeating-linear-gradient. Command prompt style (> prefix). Matrix vibes.',
          bg: '#000000',
        },
        {
          name: 'Retro VHS',
          desc: 'Distorted retro look. Text has chromatic aberration (offset red/blue shadows). Slight skew transforms. Grainy noise overlay using random positioned tiny divs. Bold chunky text. Warm amber/orange palette on dark.',
          bg: '#0a0808',
        },
        {
          name: 'Minimalist Line Art',
          desc: 'Ultra clean. Thin white lines that draw themselves (width animates from 0). Small elegant text (32-48px). Lots of whitespace. Single accent color. Geometric shapes (circles, lines) animate in. Apple keynote style.',
          bg: '#000000',
        },
        {
          name: 'Magazine Layout',
          desc: 'Bold editorial design. Mix huge serif text with small sans-serif. Overlapping elements. One word per line at different sizes. Red/black/white palette. Rotated text elements. Fashion magazine energy.',
          bg: '#f5f0eb',
        },
        {
          name: 'Isometric Icons',
          desc: 'CSS-only 3D isometric shapes (transform: rotateX(45deg) rotateZ(45deg)). Colored blocks that stack and build. Grid of isometric cubes/shapes. Tech/startup feel. Purple/teal/coral palette.',
          bg: '#0d0d1a',
        },
        {
          name: 'Progress Journey',
          desc: 'Horizontal timeline/roadmap that builds left to right. Dots connected by animated lines. Labels appear at each node. Progress percentage counter. Shows a journey or process. Clean blue/white.',
          bg: '#0a1628',
        },
        {
          name: 'Quote Showcase',
          desc: 'Large quotation marks (200px, low opacity). Quote text centered and large. Author/source below. Elegant serif font feel (use Inter weight 400 for quotes). Subtle animated border that traces around the quote box.',
          bg: '#0a0a0a',
        },
        {
          name: 'Comparison Split',
          desc: 'Screen divided vertically. Left side: red tinted "Before/Problem". Right side: green tinted "After/Solution". Content slides in from each side. Divider line animates down the middle. VS badge in center.',
          bg: '#0a0a0a',
        },
        {
          name: 'Emoji Explosion',
          desc: 'Large relevant emoji (80-120px) that bounce in from random positions. Main text in center. Emojis orbit or float around the text. Playful and energetic. Use CSS transforms for positioning. Bright colorful feel.',
          bg: '#0a0a14',
        },
        {
          name: 'Blueprint Grid',
          desc: 'Blue background with white grid lines (like graph paper/blueprint). White text and line drawings. Technical feel. Elements draw on like a blueprint being sketched. Architectural vibe. Thin white borders.',
          bg: '#1a3a5c',
        },
        {
          name: 'Countdown Timer',
          desc: 'Large animated numbers counting down or up. Digital clock style. Each digit flips or morphs. Supporting text around the number. Urgency feel. Red/orange accent on dark. Pulsing glow on the numbers.',
          bg: '#0a0505',
        },
        {
          name: 'Stacked Bars',
          desc: 'Horizontal bars that grow from left with different widths representing data. Labels on each bar. Bars stagger in one by one from top. Color coded (each bar different shade). Clean data visualization.',
          bg: '#0d1117',
        },
        {
          name: 'Floating Bubbles',
          desc: 'Text inside circular bubbles that float up and settle into position. Bubbles have soft gradients and subtle shadows. Different sizes for hierarchy. Connected by thin lines. Mind-map feel.',
          bg: '#080820',
        },
        {
          name: 'Cinematic Bars',
          desc: 'Letterbox black bars top and bottom that slide in first. Then text appears in the cinematic widescreen area. Film grain texture. Subtle camera shake effect (tiny random transforms). Movie title card energy.',
          bg: '#000000',
        },
        {
          name: 'Morphing Shapes',
          desc: 'Abstract background shapes (blobs using border-radius: 50%) that slowly morph and shift colors. Text overlaid on top. Shapes are large, blurred, and colorful (purple, blue, pink). Dreamy ambient feel.',
          bg: '#0a0a1a',
        },
        {
          name: 'Newspaper Headline',
          desc: 'Breaking news style. "BREAKING" banner slides in from top. Large headline text. Scrolling ticker at bottom. Red/white/black palette. Bold, urgent feel. News channel lower third style elements.',
          bg: '#1a0000',
        },
        {
          name: 'Reveal Wipe',
          desc: 'Content hidden behind a colored panel that wipes away (clip-path animation via JS). Reveals text/content underneath. Multiple wipes in sequence. Sharp geometric. Gold/black luxury feel.',
          bg: '#0a0a0a',
        },
        {
          name: 'Orbit System',
          desc: 'Central element with items orbiting around it using CSS transforms and rotation. Solar system metaphor. Central topic with related concepts orbiting. Dotted orbit paths. Space/tech feel.',
          bg: '#050515',
        },
        {
          name: 'Watercolor Splash',
          desc: 'Soft pastel colored blobs (large border-radius divs with gradients and opacity 0.3-0.5) that spread outward. Clean text on top. Artistic, creative feel. Warm pastels: peach, lavender, mint. Light theme.',
          bg: '#faf5f0',
        },
      ];

      // Shuffle styles so each batch gets random variety
      if (i === 0) {
        // Fisher-Yates shuffle on first iteration
        for (let si = VISUAL_STYLES.length - 1; si > 0; si--) {
          const sj = Math.floor(Math.random() * (si + 1));
          [VISUAL_STYLES[si], VISUAL_STYLES[sj]] = [VISUAL_STYLES[sj], VISUAL_STYLES[si]];
        }
      }
      // Use forced style if specified, otherwise use shuffled style
      let styleForAnimation = VISUAL_STYLES[i % VISUAL_STYLES.length];
      if (plan.forcedStyle) {
        const forced = VISUAL_STYLES.find(s => s.name.toLowerCase() === plan.forcedStyle.toLowerCase());
        if (forced) styleForAnimation = forced;
      }

      // Generate HTML animation with Gemini (for FrameForge rendering)
      const sceneResult = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [{
            text: `Create a self-contained HTML animation for a video overlay. This will be rendered to MP4 by FrameForge.

ANIMATION TYPE: ${plan.type}
TITLE: ${plan.title}
DESCRIPTION: ${plan.description}
CONTEXT: ${plan.relevantContent}
DURATION: ${plan.duration} seconds
SIZE: ${width}x${height}

VISUAL STYLE: ${styleForAnimation.name}
${styleForAnimation.desc}

Write a COMPLETE HTML file with embedded CSS and JavaScript.

CRITICAL REQUIREMENTS:
- Background: ${styleForAnimation.bg} (this exact color)
- Import Google Font Inter: @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap')
- Set html,body to exactly ${width}px x ${height}px, overflow:hidden
- ALL animation via requestAnimationFrame + performance.now() (no CSS animation keyframes - they won't work in this renderer)
- Use helper functions: lerp(a,b,t), ease(t)=1-Math.pow(1-t,3), clamp(t,start,end)
- Text must be LARGE: 48-96px for headings, 24-36px for body
- Stagger element animations with 0.2-0.4s delays between them
- Keep animating for the full ${plan.duration} seconds (add subtle pulsing/floating after initial reveal)

ANIMATION PHASES:
Phase 1 (0-0.5s): Background elements appear, accent lines sweep in
Phase 2 (0.5-2s): Main content animates in with ${styleForAnimation.name} style
Phase 3 (2s-end): Subtle continued motion - floating, pulsing, color shifts

DO NOT use CSS @keyframes or CSS animation property. ONLY use JavaScript requestAnimationFrame.
DO NOT use any external libraries. Pure vanilla JS and CSS.

Return ONLY the raw HTML. No markdown fences. Start with <!DOCTYPE html>.`
          }]
        }],
      });

      let htmlContent;
      const durationInSeconds = plan.duration;
      try {
        htmlContent = sceneResult.candidates[0].content.parts[0].text;
        // Strip markdown fences if present
        htmlContent = htmlContent.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
        if (!htmlContent.startsWith('<!DOCTYPE') && !htmlContent.startsWith('<html')) {
          // Try to find HTML in response
          const htmlMatch = htmlContent.match(/<!DOCTYPE[\s\S]*<\/html>/i) || htmlContent.match(/<html[\s\S]*<\/html>/i);
          if (htmlMatch) htmlContent = htmlMatch[0];
        }
      } catch (parseError) {
        console.error(`[${jobId}] Failed to get HTML for animation ${i + 1}, using fallback`);
        htmlContent = `<!DOCTYPE html><html><head>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#0a0a0a;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif}
.title{font-size:64px;font-weight:900;color:#fff;opacity:0;transform:translateY(30px)}
.sub{font-size:28px;color:#888;opacity:0;margin-top:12px}
.bar{width:0;height:4px;background:linear-gradient(90deg,#6366f1,#f97316);margin-top:20px;border-radius:2px}
.wrap{text-align:center}
</style></head><body><div class="wrap">
<div class="title" id="t">${plan.title}</div>
<div class="bar" id="b"></div>
<div class="sub" id="s">${plan.description.substring(0, 60)}</div>
</div><script>
function e(t){return 1-Math.pow(1-t,3)}
function c(t,a,b){return Math.max(0,Math.min(1,(t-a)/(b-a)))}
function u(){var t=performance.now()/1000;
var tp=e(c(t,0.3,1));document.getElementById('t').style.opacity=tp;document.getElementById('t').style.transform='translateY('+(30*(1-tp))+'px)';
document.getElementById('b').style.width=(e(c(t,1,2))*300)+'px';
var sp=e(c(t,1.5,2.2));document.getElementById('s').style.opacity=sp;
requestAnimationFrame(u)}requestAnimationFrame(u);
</script></body></html>`;
      }

      // Save HTML and scene data
      const htmlPath = join(session.dir, `${assetId}.html`);
      writeFileSync(htmlPath, htmlContent);
      const sceneData = { html: true, title: plan.title, type: plan.type, description: plan.description };
      writeFileSync(sceneDataPath, JSON.stringify(sceneData, null, 2));

      // Render with FrameForge
      // Check multiple locations for FrameForge CLI
      const frameforgeLocations = [
        join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'workspace', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
        join(process.cwd(), '..', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
        join(process.cwd(), '..', '..', 'frameforge', 'packages', 'core', 'dist', 'cli.js'),
      ];
      const frameforgeCliPath = frameforgeLocations.find(p => existsSync(p)) || frameforgeLocations[0];
      const useFrameForge = existsSync(frameforgeCliPath);

      if (useFrameForge) {
        console.log(`[${jobId}] Rendering with FrameForge...`);
        await new Promise((resolve, reject) => {
          const proc = spawn('node', [
            frameforgeCliPath, 'render', htmlPath,
            '--output', outputPath,
            '--duration', String(Math.ceil(durationInSeconds)),
            '--width', String(width),
            '--height', String(height),
          ], {
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, GEMINI_API_KEY: apiKey },
          });

          let stderr = '';
          proc.stderr.on('data', (data) => { stderr += data.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FrameForge render failed: ${stderr.substring(0, 200)}`));
          });
          proc.on('error', (err) => reject(new Error(`Failed to start FrameForge: ${err.message}`)));
        });
      } else {
        // Fallback to Remotion if FrameForge not available
        console.log(`[${jobId}] FrameForge not found, falling back to Remotion...`);
        writeFileSync(propsPath, JSON.stringify({
          scenes: [{ id: 'scene-1', type: 'title', duration: durationInSeconds * fps,
            content: { title: plan.title, subtitle: plan.description.substring(0, 50),
              backgroundColor: '#1a1a2e', textColor: '#ffffff', accentColor: '#6366f1' }
          }],
          totalDuration: durationInSeconds * fps, backgroundColor: '#1a1a2e'
        }, null, 2));

        const remotionArgs = [
          'remotion', 'render', 'src/remotion/index.tsx', 'DynamicAnimation', outputPath,
          '--props', propsPath, '--frames', `0-${Math.round(durationInSeconds * fps) - 1}`,
          '--fps', String(fps), '--width', String(width), '--height', String(height),
          '--codec', 'h264', '--overwrite', '--gl=angle',
        ];
        await new Promise((resolve, reject) => {
          const proc = spawn(NPX_CMD, remotionArgs, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
          let stderr = '';
          proc.stderr.on('data', (data) => { stderr += data.toString(); });
          proc.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`Remotion failed: ${stderr.substring(0, 200)}`)); });
          proc.on('error', (err) => reject(new Error(`Failed to start Remotion: ${err.message}`)));
        });
      }

      // Clean up HTML file
      try { unlinkSync(htmlPath); } catch (e) {}

      // Generate thumbnail
      try {
        await runFFmpeg([
          '-y', '-i', outputPath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);
      } catch (e) {
        console.warn(`[${jobId}] Thumbnail failed for animation ${i + 1}`);
      }

      // Clean up props file
      try { unlinkSync(propsPath); } catch (e) {}

      const { stat } = await import('fs/promises');
      const stats = await stat(outputPath);

      // Create asset entry
      const asset = {
        id: assetId,
        type: 'video',
        filename: `${plan.type}-${plan.title.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20)}.mp4`,
        path: outputPath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: durationInSeconds,
        size: stats.size,
        width,
        height,
        createdAt: Date.now(),
        aiGenerated: true,
        sceneData,
        sceneDataPath,
        description: plan.description,
      };

      session.assets.set(assetId, asset);

      generatedAnimations.push({
        assetId,
        filename: asset.filename,
        duration: durationInSeconds,
        startTime: plan.startTime,
        type: plan.type,
        title: plan.title,
        thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
      });

      console.log(`[${jobId}] ✓ Animation ${i + 1} complete: ${asset.filename}`);
    }

    console.log(`[${jobId}] === BATCH GENERATION COMPLETE ===`);
    console.log(`[${jobId}] Generated ${generatedAnimations.length} animations\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      animations: generatedAnimations,
      videoDuration: videoAsset.duration,
    }));

  } catch (error) {
    console.error('Batch animation generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Analyze video for animation concept (no rendering - for approval workflow)
// Returns transcript and proposed animation scenes for user approval
async function handleAnalyzeForAnimation(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, type = 'intro', description, startTime, endTime } = body;

    // Debug: log received time range values
    console.log(`[DEBUG] Received analyze request - startTime: ${startTime} (${typeof startTime}), endTime: ${endTime} (${typeof endTime})`);

    // Get the video asset to analyze
    let videoAsset;
    if (assetId) {
      videoAsset = session.assets.get(assetId);
    } else {
      for (const [id, asset] of session.assets) {
        if (asset.type === 'video') {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found to analyze' }));
      return;
    }

    const jobId = randomUUID();
    const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

    // Determine if we're analyzing a specific time range or the whole video
    const hasTimeRange = typeof startTime === 'number' && typeof endTime === 'number';
    const segmentStart = hasTimeRange ? startTime : 0;
    const segmentDuration = hasTimeRange ? (endTime - startTime) : null;

    console.log(`\n[${jobId}] === ANALYZE VIDEO FOR ${type.toUpperCase()} ANIMATION ===`);
    console.log(`[${jobId}] Analyzing video: ${videoAsset.filename}`);
    if (hasTimeRange) {
      console.log(`[${jobId}] Time range: ${segmentStart.toFixed(1)}s - ${endTime.toFixed(1)}s (${segmentDuration.toFixed(1)}s segment)`);
    }

    // Step 1: Transcribe the video (or just the specified segment)
    console.log(`[${jobId}] Step 1: Transcribing ${hasTimeRange ? 'segment' : 'video'}...`);

    // Extract audio from video - optionally just from the specified time range
    const ffmpegArgs = ['-y', '-i', videoAsset.path];
    if (hasTimeRange) {
      // Use -ss for seeking and -t for duration to extract only the segment
      ffmpegArgs.push('-ss', segmentStart.toString());
      ffmpegArgs.push('-t', segmentDuration.toString());
    }
    ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-q:a', '9', audioPath);

    await runFFmpeg(ffmpegArgs, jobId);

    // Get video duration
    const durationOutput = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoAsset.path
    ], jobId);
    const totalDuration = parseFloat(durationOutput.trim()) || 60;
    const analyzedDuration = hasTimeRange ? segmentDuration : totalDuration;

    let transcription;
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Helper function to transcribe with Gemini (always available as fallback)
    const transcribeWithGemini = async () => {
      console.log(`[${jobId}]    Using Gemini for transcription...`);
      const ai = new GoogleGenAI({ apiKey });
      const audioBuffer = readFileSync(audioPath);
      const fileSizeKB = audioBuffer.length / 1024;
      console.log(`[${jobId}]    Audio file size: ${fileSizeKB.toFixed(1)}KB`);

      // Check if audio file is too small (likely no audio track in video)
      if (audioBuffer.length < 1000) {
        console.log(`[${jobId}]    Audio file too small, video may have no audio track`);
        return { text: '', words: [] };
      }

      const audioBase64 = audioBuffer.toString('base64');

      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
            { text: `Transcribe this audio. Return ONLY the text content. Duration: ${analyzedDuration.toFixed(1)}s` }
          ]
        }],
      });

      return {
        text: result.candidates?.[0]?.content?.parts?.[0]?.text || '',
        words: [],
      };
    };

    // Local Whisper on CPU is too slow for long audio — use Gemini for segments > 2 minutes
    // For animation analysis, always use Gemini for transcription — local Whisper is
    // too slow on CPU and produces unreliable output for short segments.
    console.log(`[${jobId}]    Using Gemini for transcription (fast, reliable for animation analysis)...`);
    transcription = await transcribeWithGemini();

    console.log(`[${jobId}] Transcription complete: ${transcription.text.substring(0, 100)}...`);

    // Clean up audio file
    try { unlinkSync(audioPath); } catch (e) {}

    // Step 2: Generate animation concept (scenes) without rendering
    console.log(`[${jobId}] Step 2: Generating animation concept...`);

    const genAI = new GoogleGenAI({ apiKey });

    const typePrompts = {
      intro: `Create an engaging INTRO animation that hooks viewers and introduces the video topic.
The intro should:
- Start with an attention-grabbing title or hook
- Tease what viewers will learn/see
- Build excitement for the content
- Be 4-8 seconds (120-240 frames at 30fps)`,

      outro: `Create a compelling OUTRO animation that wraps up the video.
The outro should:
- Summarize key takeaways
- Include a call-to-action (subscribe, like, etc.)
- Thank viewers
- Be 5-10 seconds (150-300 frames at 30fps)`,

      transition: `Create a smooth TRANSITION animation between sections.
The transition should:
- Be brief and visually interesting
- Match the video's tone
- Be 2-4 seconds (60-120 frames at 30fps)`,

      highlight: `Create a HIGHLIGHT animation that emphasizes a key moment.
The highlight should:
- Draw attention to an important point
- Use dynamic motion and colors
- Be 3-6 seconds (90-180 frames at 30fps)`,
    };

    // Build time context for the prompt
    const timeContext = hasTimeRange
      ? `\nNOTE: This transcript is from a SPECIFIC SEGMENT of the video (${segmentStart.toFixed(1)}s - ${endTime.toFixed(1)}s, duration: ${segmentDuration.toFixed(1)}s). Create an animation that relates ONLY to what is being discussed in this segment, not the entire video.`
      : '';

    // Keep full type guidance but append duration override when time range is set
    const baseTypePrompt = typePrompts[type] || typePrompts.intro;
    const durationGuidance = hasTimeRange
      ? `${baseTypePrompt}\n\nDURATION OVERRIDE: Ignore the duration guideline above. The animation must be EXACTLY ${segmentDuration.toFixed(1)} seconds (${Math.round(segmentDuration * 30)} total frames at 30fps). Create enough scenes to fill this full duration.`
      : baseTypePrompt;

    const scenePrompt = `You are a motion graphics designer. Analyze this video transcript and create a contextual ${type} animation concept.

VIDEO TRANSCRIPT:
"${transcription.text}"
${timeContext}

${description ? `USER HINT: "${description}"` : ''}

${durationGuidance}

Based on the video content above, return ONLY valid JSON (no markdown) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition" | "gif" | "emoji",
      "duration": <frames at 30fps>,
      "content": {
        "title": "text derived from video content",
        "subtitle": "optional",
        "items": [{"icon": "emoji", "label": "text", "description": "optional"}],
        "stats": [{"value": "number", "label": "text", "numericValue": <integer for counting>}],
        "color": "#hex accent color",
        "backgroundColor": "#hex or null for transparent",
        // For gif scenes - use GIPHY search:
        "gifSearch": "keyword to search for GIF",
        "gifLayout": "fullscreen" | "scattered",
        // For emoji scenes:
        "emojis": [{"emoji": "🔥", "x": 50, "y": 50, "scale": 0.2, "animation": "bounce"}]
      }
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of scene durations>,
  "contentSummary": "brief description of what the video is about",
  "keyTopics": ["topic1", "topic2", "topic3"]
}

Scene type notes:
- "gif": Use "gifSearch" to search GIPHY for GIFs (e.g., "mind blown", "celebration", "thumbs up")
- "emoji": Animated emoji scene with animations (pop, bounce, float, pulse)
- "stats": Use numericValue for counting animation (must be a NUMBER)

IMPORTANT: The animation content should directly relate to the video's actual topic and message.
Use specific terms, concepts, and themes from the transcript.
Feel free to add a GIF scene for reactions or emphasis when appropriate!`;

    const sceneResult = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: scenePrompt }] }],
      config: { responseMimeType: 'application/json' },
    });

    let sceneData;
    try {
      const responseText = sceneResult.candidates[0].content.parts[0].text;
      sceneData = JSON.parse(responseText);
    } catch (parseError) {
      const rawText = sceneResult.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
      console.error(`[${jobId}] Failed to parse Gemini response. Raw (first 500 chars):`, rawText.substring(0, 500));
      throw new Error('Failed to parse AI-generated scene data');
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKeyForAnalysis = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKeyForAnalysis) {
          console.log(`[${jobId}] 🎬 Fetching GIFs from GIPHY for concept: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifs = await searchGiphy(term, 1);
              if (gifs.length > 0) {
                const gif = gifs[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed: ${err.message}`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          }
        }
      }
    }

    // Enforce exact duration when user specified a time range
    if (hasTimeRange) {
      const targetFrames = Math.round(segmentDuration * 30);
      const actualFrames = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
      if (Math.abs(actualFrames - targetFrames) > 3) {
        const scale = targetFrames / actualFrames;
        console.log(`[${jobId}] ⏱️ Scaling scenes from ${(actualFrames/30).toFixed(1)}s to ${segmentDuration.toFixed(1)}s (scale: ${scale.toFixed(2)}x)`);
        sceneData.scenes.forEach(scene => {
          scene.duration = Math.max(15, Math.round(scene.duration * scale));
        });
      }
      sceneData.totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    }

    const animationTotalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / 30; // 30 fps

    console.log(`[${jobId}] Analysis complete: ${sceneData.scenes.length} scenes, ${durationInSeconds}s total`);
    console.log(`[${jobId}] === ANALYSIS COMPLETE (awaiting approval) ===\n`);

    // Return the concept for user approval (NOT rendered yet)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      concept: {
        type,
        transcript: transcription.text,
        transcriptPreview: transcription.text.substring(0, 500) + (transcription.text.length > 500 ? '...' : ''),
        contentSummary: sceneData.contentSummary,
        keyTopics: sceneData.keyTopics || [],
        scenes: sceneData.scenes,
        totalDuration: animationTotalDuration,
        durationInSeconds,
        backgroundColor: sceneData.backgroundColor,
      },
      videoInfo: {
        filename: videoAsset.filename,
        duration: totalDuration,
        assetId: videoAsset.id,
      },
    }));

  } catch (error) {
    console.error('Animation analysis error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Render animation from pre-approved concept (skips analysis, uses provided scenes)
async function handleRenderFromConcept(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { concept, fps = 30, width = 1920, height = 1080 } = body;

    if (!concept || !concept.scenes || concept.scenes.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'concept with scenes is required' }));
      return;
    }

    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);

    console.log(`\n[${jobId}] === RENDER FROM APPROVED CONCEPT ===`);
    console.log(`[${jobId}] Type: ${concept.type}, Scenes: ${concept.scenes.length}`);

    const sceneData = {
      scenes: concept.scenes,
      backgroundColor: concept.backgroundColor || '#0a0a0a',
      totalDuration: concept.totalDuration,
      contentSummary: concept.contentSummary,
      keyTopics: concept.keyTopics,
    };

    // Post-process GIF scenes - search GIPHY for any unresolved gif searches
    const giphyKeyForRender = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches, gifs } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        // Only search if we have search terms but no resolved GIFs
        if (searchTerms.length > 0 && (!gifs || gifs.length === 0) && giphyKeyForRender) {
          console.log(`[${jobId}] 🎬 Resolving GIPHY searches: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifsResult = await searchGiphy(term, 1);
              if (gifsResult.length > 0) {
                const gif = gifsResult[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Resolved GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed: ${err.message}`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          }
        }
      }
    }

    // Save scene data for future editing (reusable path based on asset ID)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    writeFileSync(sceneDataPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    const animationTotalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    // Write props to JSON file for Remotion
    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);
    console.log(`[${jobId}] Scene data:`, JSON.stringify(sceneData, null, 2));

    // Render with Remotion CLI
    console.log(`[${jobId}] Rendering with Remotion...`);

    const remotionArgs = [
      'remotion', 'render',
      'src/remotion/index.tsx',
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${animationTotalDuration - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
      '--gl=angle', // Use Metal GPU acceleration on macOS
    ];

    console.log(`[${jobId}] Remotion command: npx ${remotionArgs.join(' ')}`);

    await new Promise((resolve, reject) => {
      const proc = spawn(NPX_CMD, remotionArgs, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[${jobId}] Remotion stdout: ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
          console.log(`[${jobId}] Remotion: ${line}`);
        });
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else {
          console.error(`[${jobId}] Remotion failed. stderr: ${stderr.slice(-1000)}`);
          reject(new Error(`Remotion render failed with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => reject(new Error(`Failed to start Remotion: ${err.message}`)));
    });

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up props file
    try { unlinkSync(propsPath); } catch (e) {}

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry with scene data for future editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `${concept.type}-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      aiGenerated: true,
      contextual: true,
      animationType: concept.type,
      contentSummary: concept.contentSummary,
      sceneCount: concept.scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Animation rendered: ${assetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === RENDER COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      type: concept.type,
      sceneCount: concept.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Render from concept error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate kinetic typography animation from video transcript
// Transcribes video, identifies key phrases, creates animated text scenes synced to audio
async function handleGenerateTranscriptAnimation(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { fps = 30, width = 1920, height = 1080 } = body;

    // Find the first video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video') {
        videoAsset = asset;
        break;
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE TRANSCRIPT ANIMATION ===`);
    console.log(`[${jobId}] Video: ${videoAsset.filename}`);

    // Step 1: Transcribe the video with word-level timestamps
    console.log(`[${jobId}] Step 1: Transcribing video...`);
    const audioPath = join(TEMP_DIR, `${jobId}-transcript-audio.mp3`);
    const totalDuration = await getVideoDuration(videoAsset.path);

    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    // Check transcription method
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Helper for Gemini fallback
    const transcribeWithGeminiForAnimation = async () => {
      console.log(`[${jobId}]    Using Gemini for transcription...`);
      const audioBuffer = readFileSync(audioPath);
      const audioBase64 = audioBuffer.toString('base64');
      const ai = new GoogleGenAI({ apiKey });
      const geminiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
          { text: `Transcribe this audio with word timestamps. Duration: ${totalDuration}s. Return JSON: {"text": "...", "words": [{"text": "word", "start": 0.0, "end": 0.5}]}` }
        ]}]
      });
      const respText = geminiResponse.text || '';
      try {
        return JSON.parse(respText);
      } catch {
        const match = respText.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : { text: respText, words: [] };
      }
    };

    let transcription;
    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to Gemini...`);
        transcription = await transcribeWithGeminiForAnimation();
      }
    } else if (openaiKey) {
      console.log(`[${jobId}]    Using OpenAI Whisper API...`);
      const audioBuffer = readFileSync(audioPath);
      const formData = new globalThis.FormData();
      formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: formData,
      });

      if (!whisperResponse.ok) {
        throw new Error(`Whisper API error: ${whisperResponse.status}`);
      }

      const whisperResult = await whisperResponse.json();
      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map(w => ({
          text: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        }))
      };
    } else {
      transcription = await transcribeWithGeminiForAnimation();
    }

    try { unlinkSync(audioPath); } catch {}

    console.log(`[${jobId}]    Transcript: "${transcription.text.substring(0, 100)}..."`);
    console.log(`[${jobId}]    Words: ${transcription.words?.length || 0}`);

    // Step 2: Use Gemini to identify key phrases for animation
    console.log(`[${jobId}] Step 2: Identifying key phrases...`);
    const ai = new GoogleGenAI({ apiKey });

    const analysisPrompt = `Analyze this video transcript and identify 5-8 KEY PHRASES that would make great kinetic typography animations. These should be:
- Important or impactful statements
- Keywords or product names
- Emotional or emphatic moments
- Key points the speaker is making

Transcript: "${transcription.text}"

Word timestamps: ${JSON.stringify(transcription.words?.slice(0, 100) || [])}
(Total duration: ${totalDuration}s)

Return JSON array of phrases to animate:
[
  {
    "phrase": "the exact phrase from transcript",
    "startTime": 1.5,
    "endTime": 3.2,
    "emphasis": "high|medium|low",
    "style": "bold|explosive|subtle|typewriter",
    "reason": "why this phrase is important"
  }
]

Pick phrases that are spread throughout the video. Each phrase should be 2-6 words.`;

    const analysisResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }]
    });

    let keyPhrases = [];
    try {
      const respText = analysisResponse.text || '';
      const jsonMatch = respText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        keyPhrases = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error(`[${jobId}] Failed to parse key phrases:`, e.message);
    }

    if (keyPhrases.length === 0) {
      // Fallback: create basic phrases from transcript chunks
      const words = transcription.words || [];
      const chunkSize = Math.ceil(words.length / 6);
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize);
        if (chunk.length > 0) {
          keyPhrases.push({
            phrase: chunk.map(w => w.text).join(' ').trim(),
            startTime: chunk[0].start,
            endTime: chunk[chunk.length - 1].end,
            emphasis: 'medium',
            style: 'typewriter'
          });
        }
      }
    }

    console.log(`[${jobId}]    Found ${keyPhrases.length} key phrases`);

    // Step 3: Generate Remotion scenes for each phrase
    console.log(`[${jobId}] Step 3: Generating animation scenes...`);
    const scenes = keyPhrases.map((phrase, index) => {
      const duration = Math.max(60, Math.round((phrase.endTime - phrase.startTime + 1) * fps)); // At least 2 seconds

      // Map emphasis to visual style
      const colors = {
        high: '#f97316', // orange
        medium: '#3b82f6', // blue
        low: '#22c55e', // green
      };

      return {
        id: `text-${index}`,
        type: 'text',
        duration,
        content: {
          title: phrase.phrase.toUpperCase(),
          subtitle: null,
          color: colors[phrase.emphasis] || '#ffffff',
          backgroundColor: '#0a0a0a',
          style: phrase.style || 'typewriter',
        }
      };
    });

    // Calculate total animation duration
    const animationTotalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    console.log(`[${jobId}]    Total animation: ${animationTotalDuration} frames (${durationInSeconds}s)`);

    // Step 4: Render with Remotion
    console.log(`[${jobId}] Step 4: Rendering with Remotion...`);

    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-transcript-props.json`);

    const sceneData = {
      scenes,
      backgroundColor: '#0a0a0a',
      totalDuration: animationTotalDuration,
      contentSummary: `Kinetic typography animation from transcript: "${transcription.text.substring(0, 100)}..."`,
      keyTopics: keyPhrases.map(p => p.phrase),
    };

    // Save scene data for future editing (persistent path based on asset ID)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    writeFileSync(sceneDataPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));

    const remotionArgs = [
      'remotion', 'render',
      'src/remotion/index.tsx',
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${animationTotalDuration - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
      '--gl=angle', // Use Metal GPU acceleration on macOS
    ];

    console.log(`[${jobId}] Remotion command: npx ${remotionArgs.join(' ')}`);

    await new Promise((resolve, reject) => {
      const proc = spawn(NPX_CMD, remotionArgs, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      proc.stdout.on('data', (data) => {
        console.log(`[${jobId}] Remotion: ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => console.log(`[${jobId}] Remotion: ${line}`));
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Remotion render failed with code ${code}`));
      });

      proc.on('error', (err) => reject(new Error(`Failed to start Remotion: ${err.message}`)));
    });

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    try { unlinkSync(propsPath); } catch {}

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry with scene data for future editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `transcript-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      aiGenerated: true,
      transcriptAnimation: true,
      phraseCount: keyPhrases.length,
      sceneCount: scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Transcript animation created: ${assetId}`);
    console.log(`[${jobId}] === TRANSCRIPT ANIMATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      phraseCount: keyPhrases.length,
      phrases: keyPhrases.map(p => p.phrase),
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Transcript animation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate contextual animation based on video content
// This transcribes the video first, understands what it's about, then generates relevant animation
async function handleGenerateContextualAnimation(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, type = 'intro', description, fps = 30, width = 1920, height = 1080 } = body;

    // Get the video asset to analyze
    let videoAsset;
    if (assetId) {
      videoAsset = session.assets.get(assetId);
    } else {
      // Find the first video asset
      for (const [id, asset] of session.assets) {
        if (asset.type === 'video') {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found to analyze' }));
      return;
    }

    const jobId = randomUUID();
    const outputAssetId = randomUUID();
    const outputPath = join(session.assetsDir, `${outputAssetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${outputAssetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);
    const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

    console.log(`\n[${jobId}] === GENERATE CONTEXTUAL ${type.toUpperCase()} ANIMATION ===`);
    console.log(`[${jobId}] Analyzing video: ${videoAsset.filename}`);
    console.log(`[${jobId}] Type: ${type}, Description hint: ${description || 'none'}`);

    // Step 1: Transcribe the video to understand content
    console.log(`[${jobId}] Step 1: Transcribing video...`);

    // Extract audio from video
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-q:a', '9',
      audioPath
    ], jobId);

    // Get video duration
    const durationOutput = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoAsset.path
    ], jobId);
    const totalDuration = parseFloat(durationOutput.trim()) || 60;

    let transcription;
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Helper for Gemini fallback in contextual animation
    const transcribeWithGeminiContextual = async () => {
      console.log(`[${jobId}]    Using Gemini for transcription...`);
      const ai = new GoogleGenAI({ apiKey });
      const audioBuffer = readFileSync(audioPath);
      const audioBase64 = audioBuffer.toString('base64');

      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
            { text: `Transcribe this audio. Return ONLY the text content, no timestamps needed. Duration: ${totalDuration.toFixed(1)}s` }
          ]
        }],
      });

      return {
        text: result.candidates[0].content.parts[0].text || '',
        words: [],
      };
    };

    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to Gemini...`);
        transcription = await transcribeWithGeminiContextual();
      }
    } else if (openaiKey) {
      console.log(`[${jobId}]    Using OpenAI Whisper API...`);
      const audioBuffer = readFileSync(audioPath);
      const formData = new globalThis.FormData();
      formData.append('file', new globalThis.Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: formData,
      });

      if (!whisperResponse.ok) {
        throw new Error(`Whisper API error: ${whisperResponse.status}`);
      }

      const whisperResult = await whisperResponse.json();
      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map(w => ({
          text: w.word,
          start: w.start,
          end: w.end,
        })),
      };
    } else {
      transcription = await transcribeWithGeminiContextual();
    }

    console.log(`[${jobId}] Transcription complete: ${transcription.text.substring(0, 100)}...`);

    // Clean up audio file
    try { unlinkSync(audioPath); } catch (e) {}

    // Step 2: Analyze content and generate contextual scene data
    console.log(`[${jobId}] Step 2: Analyzing content and generating scenes...`);

    const genAI = new GoogleGenAI({ apiKey });

    const typePrompts = {
      intro: `Create an engaging INTRO animation that hooks viewers and introduces the video topic.
The intro should:
- Start with an attention-grabbing title or hook
- Tease what viewers will learn/see
- Build excitement for the content
- Be 4-8 seconds (120-240 frames at 30fps)`,

      outro: `Create a compelling OUTRO animation that wraps up the video.
The outro should:
- Summarize key takeaways
- Include a call-to-action (subscribe, like, etc.)
- Thank viewers
- Be 5-10 seconds (150-300 frames at 30fps)`,

      transition: `Create a smooth TRANSITION animation between sections.
The transition should:
- Be brief and visually interesting
- Match the video's tone
- Be 2-4 seconds (60-120 frames at 30fps)`,

      highlight: `Create a HIGHLIGHT animation that emphasizes a key moment.
The highlight should:
- Draw attention to an important point
- Use dynamic motion and colors
- Be 3-6 seconds (90-180 frames at 30fps)`,
    };

    const scenePrompt = `You are a motion graphics designer. Analyze this video transcript and create a contextual ${type} animation.

VIDEO TRANSCRIPT:
"${transcription.text}"

${description ? `USER HINT: "${description}"` : ''}

${typePrompts[type] || typePrompts.intro}

Based on the video content above, return ONLY valid JSON (no markdown) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition",
      "duration": <frames at 30fps>,
      "content": {
        "title": "text derived from video content",
        "subtitle": "optional",
        "items": [{"icon": "emoji", "label": "text", "description": "optional"}],
        "stats": [{"value": "number", "label": "text"}],
        "color": "#hex accent color",
        "backgroundColor": "#hex or null for transparent"
      }
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of scene durations>,
  "contentSummary": "brief description of what the video is about"
}

IMPORTANT: The animation content should directly relate to the video's actual topic and message.
Use specific terms, concepts, and themes from the transcript.`;

    const sceneResult = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: scenePrompt }] }],
    });

    let sceneData;
    try {
      const responseText = sceneResult.candidates[0].content.parts[0].text;
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      sceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse Gemini response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes for ${type}`);
    console.log(`[${jobId}] Content summary: ${sceneData.contentSummary || 'N/A'}`);

    // Log camera movements for debugging
    const scenesWithCamera = sceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    const animationTotalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    // Save scene data for future editing (persistent path based on asset ID)
    const sceneDataPath = join(session.dir, `${outputAssetId}-scenes.json`);
    writeFileSync(sceneDataPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    // Step 3: Write props and render with Remotion
    console.log(`[${jobId}] Step 3: Rendering with Remotion...`);

    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));

    const remotionArgs = [
      'remotion', 'render',
      'src/remotion/index.tsx',
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${animationTotalDuration - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
      '--gl=angle', // Use Metal GPU acceleration on macOS
    ];

    await new Promise((resolve, reject) => {
      const proc = spawn(NPX_CMD, remotionArgs, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[${jobId}] Remotion stdout: ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
          console.log(`[${jobId}] Remotion: ${line}`);
        });
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else {
          console.error(`[${jobId}] Remotion failed. stderr: ${stderr.slice(-1000)}`);
          reject(new Error(`Remotion render failed with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => reject(new Error(`Failed to start Remotion: ${err.message}`)));
    });

    // Step 4: Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up
    try { unlinkSync(propsPath); } catch (e) {}

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry
    // Create asset entry with scene data for future editing
    const asset = {
      id: outputAssetId,
      type: 'video',
      filename: `${type}-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      // Metadata
      aiGenerated: true,
      contextual: true,
      animationType: type,
      contentSummary: sceneData.contentSummary,
      sceneCount: sceneData.scenes.length,
      sourceAssetId: videoAsset.id,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(outputAssetId, asset);

    console.log(`[${jobId}] Contextual ${type} animation rendered: ${outputAssetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === CONTEXTUAL ANIMATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId: outputAssetId,
      filename: asset.filename,
      duration: durationInSeconds,
      type,
      contentSummary: sceneData.contentSummary,
      sceneCount: sceneData.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${outputAssetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${outputAssetId}/stream`,
    }));

  } catch (error) {
    console.error('Contextual animation generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate Remotion composition code from a text prompt
async function handleGenerateRemotion(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { prompt } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === REMOTION CODE GENERATOR ===`);
    console.log(`[${jobId}] User prompt: ${prompt.substring(0, 200)}...`);

    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `You are a Remotion code generator. Output ONLY TypeScript/TSX code with NO explanations, NO markdown, NO prose.

CRITICAL RULES:
- Output ONLY raw TypeScript/TSX code
- Do NOT use markdown code blocks (\`\`\`)
- Do NOT include any explanations or comments outside the code
- Start directly with "import" statement
- End with the config export

REQUIRED STRUCTURE:
1. Import from 'remotion': useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Easing, AbsoluteFill
2. Import React
3. Define main component with animations
4. Export config object with id, component, durationInFrames, fps, width, height

ANIMATION APIs:
- interpolate(frame, [start, end], [valueStart, valueEnd], { easing })
- spring({ frame, fps, config: { damping, stiffness } })
- Sequence from/durationInFrames for timing
- AbsoluteFill for full-frame containers
- Easing.out, Easing.inOut, Easing.bezier() for smooth motion

DEFAULT CONFIG (if not specified):
- width: 1920, height: 1080, fps: 30, durationInFrames: 240 (8 seconds)

OUTPUT EXACTLY THIS FORMAT:
import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, spring, AbsoluteFill, Sequence, Easing } from 'remotion';

export const MyComposition: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Your animation code here

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Animated elements */}
    </AbsoluteFill>
  );
};

export const myCompositionConfig = {
  id: 'MyComposition',
  component: MyComposition,
  durationInFrames: 240,
  fps: 30,
  width: 1920,
  height: 1080,
};`;

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{ text: `Generate a single, complete Remotion composition TSX file for the following request. Output ONLY the raw TypeScript code, starting with "import React" and ending with the config export object. Do NOT include any markdown formatting, code blocks, explanations, setup instructions, or prose. Just the code.\n\nRequest: ${prompt}` }]
      }],
      systemInstruction: systemPrompt,
    });

    const generatedCode = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!generatedCode || generatedCode.length < 50) {
      throw new Error('Failed to generate valid Remotion code');
    }

    // Extract code from markdown blocks if present, otherwise use as-is
    let cleanCode = generatedCode;

    // If response contains markdown code blocks, extract the largest one
    const codeBlockMatch = generatedCode.match(/```(?:tsx?|typescript|javascript)?\s*\n([\s\S]*?)```/g);
    if (codeBlockMatch && codeBlockMatch.length > 0) {
      // Find the largest code block (likely the main component)
      const blocks = codeBlockMatch.map(block =>
        block.replace(/^```(?:tsx?|typescript|javascript)?\s*\n?/, '').replace(/\n?```$/, '')
      );
      cleanCode = blocks.reduce((a, b) => a.length > b.length ? a : b);
    } else if (cleanCode.startsWith('```')) {
      // Single code block wrapping everything
      cleanCode = cleanCode.replace(/^```(?:tsx?|typescript|javascript)?\s*\n?/, '').replace(/\n?```$/, '');
    }

    // If code doesn't start with import, try to find where the actual code starts
    if (!cleanCode.trim().startsWith('import')) {
      const importMatch = cleanCode.match(/import\s+(?:React|{)/);
      if (importMatch) {
        cleanCode = cleanCode.substring(cleanCode.indexOf(importMatch[0]));
      }
    }

    console.log(`[${jobId}] Generated ${cleanCode.length} characters of Remotion code`);
    console.log(`[${jobId}] === REMOTION GENERATOR COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      code: cleanCode,
      prompt: prompt,
    }));

  } catch (error) {
    console.error('Remotion code generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Standalone Remotion generator (no session required)
async function handleGenerateRemotionStandalone(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { prompt } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    const jobId = randomUUID().substring(0, 8);
    console.log(`\n[${jobId}] === REMOTION CODE GENERATOR (STANDALONE) ===`);
    console.log(`[${jobId}] User prompt: ${prompt.substring(0, 200)}...`);

    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `You are a Remotion code generator. Output ONLY TypeScript/TSX code with NO explanations, NO markdown, NO prose.

CRITICAL RULES:
- Output ONLY raw TypeScript/TSX code
- Do NOT use markdown code blocks (\`\`\`)
- Do NOT include any explanations or comments outside the code
- Start directly with "import" statement
- End with the config export

REQUIRED STRUCTURE:
1. Import from 'remotion': useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Easing, AbsoluteFill
2. Import React
3. Define main component with animations
4. Export config object with id, component, durationInFrames, fps, width, height

ANIMATION APIs:
- interpolate(frame, [start, end], [valueStart, valueEnd], { easing })
- spring({ frame, fps, config: { damping, stiffness } })
- Sequence from/durationInFrames for timing
- AbsoluteFill for full-frame containers
- Easing.out, Easing.inOut, Easing.bezier() for smooth motion

DEFAULT CONFIG (if not specified):
- width: 1920, height: 1080, fps: 30, durationInFrames: 240 (8 seconds)

OUTPUT EXACTLY THIS FORMAT:
import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, spring, AbsoluteFill, Sequence, Easing } from 'remotion';

export const MyComposition: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Your animation code here

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Animated elements */}
    </AbsoluteFill>
  );
};

export const myCompositionConfig = {
  id: 'MyComposition',
  component: MyComposition,
  durationInFrames: 240,
  fps: 30,
  width: 1920,
  height: 1080,
};`;

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{ text: `Generate a single, complete Remotion composition TSX file for the following request. Output ONLY the raw TypeScript code, starting with "import React" and ending with the config export object. Do NOT include any markdown formatting, code blocks, explanations, setup instructions, or prose. Just the code.\n\nRequest: ${prompt}` }]
      }],
      systemInstruction: systemPrompt,
    });

    const generatedCode = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!generatedCode || generatedCode.length < 50) {
      throw new Error('Failed to generate valid Remotion code');
    }

    // Extract code from markdown blocks if present
    let cleanCode = generatedCode;
    const codeBlockMatch = generatedCode.match(/```(?:tsx?|typescript|javascript)?\s*\n([\s\S]*?)```/g);
    if (codeBlockMatch && codeBlockMatch.length > 0) {
      const blocks = codeBlockMatch.map(block =>
        block.replace(/^```(?:tsx?|typescript|javascript)?\s*\n?/, '').replace(/\n?```$/, '')
      );
      cleanCode = blocks.reduce((a, b) => a.length > b.length ? a : b);
    } else if (cleanCode.startsWith('```')) {
      cleanCode = cleanCode.replace(/^```(?:tsx?|typescript|javascript)?\s*\n?/, '').replace(/\n?```$/, '');
    }

    if (!cleanCode.trim().startsWith('import')) {
      const importMatch = cleanCode.match(/import\s+(?:React|{)/);
      if (importMatch) {
        cleanCode = cleanCode.substring(cleanCode.indexOf(importMatch[0]));
      }
    }

    console.log(`[${jobId}] Generated ${cleanCode.length} characters of Remotion code`);
    console.log(`[${jobId}] === REMOTION GENERATOR COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      code: cleanCode,
      prompt: prompt,
    }));

  } catch (error) {
    console.error('Remotion code generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Render Remotion animation from prompt (uses DynamicAnimation with scene props)
async function handleRenderRemotion(req, res, sessionId) {
  const session = sessionId ? getSession(sessionId) : null;

  try {
    const body = await parseBody(req);
    const { prompt, width = 1920, height = 1080, fps = 30, durationSeconds = 8, images = [] } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    // Check for Gemini API
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }));
      return;
    }

    const jobId = randomUUID().substring(0, 8);
    console.log(`\n[${jobId}] === REMOTION RENDER FROM PROMPT ===`);
    console.log(`[${jobId}] Rendering ${width}x${height} @ ${fps}fps, ${durationSeconds}s`);
    console.log(`[${jobId}] Prompt: ${prompt.substring(0, 100)}...`);
    if (images && images.length > 0) {
      console.log(`[${jobId}] 🖼️ ${images.length} user images provided`);
    }

    const startTime = Date.now();

    // Step 1: Generate scene data using Gemini (same approach as handleGenerateAnimation)
    console.log(`[${jobId}] Generating scene data with Gemini...`);

    const ai = new GoogleGenAI({ apiKey: geminiKey });

    const targetFrames = Math.round(durationSeconds * fps);

    // Build images section for prompt if user provided images
    // Use placeholders instead of actual URLs to prevent Gemini from mistyping UUIDs
    const imageUrlMap = {};
    const imagesSection = images && images.length > 0
      ? `\n\n⚠️ CRITICAL - USER HAS PROVIDED ${images.length} IMAGE(S) TO USE:
${images.map((img, i) => {
  const placeholder = `{{IMAGE_${i + 1}}}`;
  imageUrlMap[placeholder] = img.url;
  return `  Image ${i + 1}: "${img.filename}" → mediaPath: "${placeholder}"`;
}).join('\n')}

🎯 THE USER'S IMAGE(S) ARE THE MAIN VISUAL ELEMENT!

⚠️ WHEN USER PROVIDES IMAGES: CREATE EXACTLY ONE "media" SCENE - NO INTRO, NO OUTRO, NO EXTRAS!
The user uploaded their image for a reason - they want THAT image displayed with effects, NOT a bunch of generic scenes.

Follow these rules:
1. Create a SINGLE "media" scene that displays the user's image FULLSCREEN
2. Use mediaStyle: "fullscreen" - the image IS the entire video
3. Apply any text the user wants via overlayText ON TOP of the image
4. Apply any effects the user wants via mediaAnimation (pulse, glow, ken-burns, etc.)
5. The user's image IS whatever they're referring to (box, frame, background, etc.)
6. DO NOT add intro scenes, outro scenes, emoji scenes, or "variety" - JUST THE USER'S IMAGE WITH THEIR REQUESTED EFFECTS
7. Duration: Use ALL ${durationSeconds} seconds for this ONE scene

Example media scene with overlay text:
{"id": "main", "type": "media", "duration": 240, "content": {
  "mediaPath": "{{IMAGE_1}}",
  "mediaType": "image",
  "mediaStyle": "fullscreen",
  "overlayText": "SUBSCRIBE",
  "overlayPosition": "center",
  "overlayStyle": "bold",
  "mediaAnimation": {"type": "pulse", "intensity": 0.3},
  "camera": {"type": "zoom-in", "intensity": 0.2}
}, "transition": {"type": "fade"}}`
      : '';

    const scenePrompt = `You are an expert motion graphics designer. Create a visually stunning animation by generating scene data JSON.

USER REQUEST: ${prompt}${imagesSection}

OUTPUT FORMAT - Return ONLY valid JSON with this structure:
{
  "scenes": [...],
  "backgroundColor": "#0a0a0a",
  "totalDuration": ${targetFrames}
}

SCENE TYPES (only use what the user asks for):

1. "title" - Big animated text
   {"id": "intro", "type": "title", "duration": 60, "content": {"title": "MAIN TEXT", "subtitle": "smaller text", "color": "#f97316"}, "transition": {"type": "zoom-in", "duration": 15}}

2. "emoji" - Animated emoji characters (only if user specifically asks for emojis)
   {"id": "emojis", "type": "emoji", "duration": 45, "content": {"emojis": [
     {"emoji": "🔥", "x": 25, "y": 40, "scale": 0.25, "animation": "bounce"},
     {"emoji": "⭐", "x": 50, "y": 30, "scale": 0.2, "animation": "spin"},
     {"emoji": "🚀", "x": 75, "y": 50, "scale": 0.3, "animation": "float"}
   ], "emojiLayout": "custom"}, "transition": {"type": "swipe-left"}}

3. "shapes" - Animated geometric shapes (circles, stars, triangles)
   {"id": "shapes", "type": "shapes", "duration": 60, "content": {"shapes": [
     {"type": "star", "fill": "#f97316", "x": 50, "y": 50, "scale": 1.5, "animation": "spin", "points": 5},
     {"type": "circle", "fill": "#3b82f6", "x": 30, "y": 60, "scale": 0.8, "animation": "pulse"},
     {"type": "triangle", "fill": "#22c55e", "x": 70, "y": 40, "scale": 1, "animation": "bounce"}
   ], "shapesLayout": "custom"}, "transition": {"type": "fade"}}

4. "stats" - Animated counting numbers (MUST include numericValue as INTEGER!)
   {"id": "stats", "type": "stats", "duration": 90, "content": {"stats": [
     {"value": "10K+", "label": "Subscribers", "numericValue": 10000, "suffix": "+"},
     {"value": "$50K", "label": "Revenue", "numericValue": 50000, "prefix": "$"},
     {"value": "99%", "label": "Satisfaction", "numericValue": 99, "suffix": "%"}
   ], "color": "#8b5cf6"}, "transition": {"type": "swipe-right"}}

5. "countdown" - Animated countdown timer
   {"id": "countdown", "type": "countdown", "duration": 120, "content": {"countFrom": 5, "countTo": 0, "color": "#ec4899"}}

6. "steps" or "features" - List with icons
   {"id": "steps", "type": "steps", "duration": 90, "content": {"items": [
     {"icon": "1", "label": "First Step", "description": "Do this first"},
     {"icon": "2", "label": "Second Step", "description": "Then do this"},
     {"icon": "3", "label": "Final Step", "description": "Complete!"}
   ], "color": "#22c55e"}, "transition": {"type": "swipe-up"}}

7. "chart" - Data visualization
   {"id": "chart", "type": "chart", "duration": 90, "content": {"chartType": "bar", "chartData": [
     {"label": "Jan", "value": 65, "color": "#3b82f6"},
     {"label": "Feb", "value": 80, "color": "#22c55e"},
     {"label": "Mar", "value": 95, "color": "#f97316"}
   ], "maxValue": 100}, "transition": {"type": "fade"}}

8. "comparison" - Before/After
   {"id": "compare", "type": "comparison", "duration": 75, "content": {"beforeLabel": "BEFORE", "afterLabel": "AFTER", "beforeValue": "50%", "afterValue": "99%"}}

9. "text" - Simple text message
   {"id": "cta", "type": "text", "duration": 45, "content": {"title": "Click the link below!", "color": "#f97316"}}

10. "gif" - Animated GIF from GIPHY (auto-fetched by search term!)
   {"id": "reaction", "type": "gif", "duration": 60, "content": {"gifSearch": "mind blown", "gifLayout": "fullscreen"}, "transition": {"type": "zoom-in"}}
   Popular searches: "celebration", "mind blown", "excited", "thumbs up", "fire", "applause", "wow", "success", "dancing"

11. "media" - Animated image/photo with cinematic effects (USE WHEN USER PROVIDES IMAGES!)
   {"id": "photo1", "type": "media", "duration": 90, "content": {
     "mediaPath": "IMAGE_URL_HERE",
     "mediaType": "image",
     "mediaStyle": "fullscreen",
     "mediaAnimation": {"type": "ken-burns", "intensity": 0.4},
     "overlayText": "Optional text overlay",
     "overlayPosition": "bottom",
     "camera": {"type": "zoom-in", "intensity": 0.2}
   }, "transition": {"type": "fade"}}
   Media styles: "fullscreen", "framed", "circle", "phone-frame", "split-left", "split-right"
   Media animations: "ken-burns" (slow zoom+pan), "zoom-in", "zoom-out", "pan-left", "pan-right", "rotate", "parallax"

CAMERA MOVEMENTS (add to content for dynamic feel):
- "camera": {"type": "zoom-in", "intensity": 0.3} - Dramatic focus
- "camera": {"type": "zoom-out", "intensity": 0.25} - Reveal effect
- "camera": {"type": "ken-burns", "intensity": 0.3} - Cinematic slow zoom+pan
- "camera": {"type": "pan-left", "intensity": 0.2} - Horizontal movement
- "camera": {"type": "shake", "intensity": 0.15} - Energy/impact

TRANSITIONS (between scenes - REQUIRED for professional look!):
- "swipe-left", "swipe-right", "swipe-up", "swipe-down" - Dynamic slides (most common)
- "fade" - Smooth crossfade (elegant, professional)
- "wipe-left", "wipe-right" - Reveal effect (dramatic)
- "flip" - 3D rotation (attention-grabbing)
- "clock" - Circular clock wipe (unique, engaging)
- "zoom-in", "zoom-out" - Scale transitions (impact)

EMOJI ANIMATIONS: "pop", "bounce", "float", "pulse", "spin", "shake", "wave"
SHAPE ANIMATIONS: "pop", "spin", "bounce", "float", "pulse"
SHAPE TYPES: "circle", "rect", "star", "triangle", "polygon", "ellipse"

VIBRANT COLORS: #f97316 (orange), #3b82f6 (blue), #22c55e (green), #8b5cf6 (purple), #ec4899 (pink), #eab308 (yellow), #ef4444 (red), #06b6d4 (cyan)

CRITICAL RULES:
1. Target duration: EXACTLY ${durationSeconds} seconds = ${targetFrames} frames at ${fps}fps
2. ⚠️ ONLY CREATE SCENES THE USER EXPLICITLY ASKS FOR - NO EXTRAS!
3. If user provides images: Create ONE "media" scene showing their image fullscreen with requested effects
4. DO NOT add intro scenes, outro scenes, emoji scenes, CTAs, or "variety" scenes unless specifically requested
5. The user's prompt is the EXACT specification - fulfill it literally, nothing more
6. For stats: numericValue MUST be an integer (10000 not "10000")
7. If user asks for text on their image: ONE media scene with overlayText property
8. If user asks for effects on their image: Apply via mediaAnimation property (pulse, glow, ken-burns, etc.)
9. Transitions are only needed if you have MULTIPLE scenes (which you shouldn't unless user asked for them)
10. When in doubt: SIMPLER IS BETTER. One scene that does exactly what was asked beats 8 scenes with fluff

Return ONLY the JSON object, no markdown code blocks or explanation.`;

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: scenePrompt }] }],
    });

    let sceneData;
    try {
      const responseText = result.candidates[0].content.parts[0].text;
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      sceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse Gemini response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes`);

    // Replace image placeholders with actual URLs
    if (Object.keys(imageUrlMap).length > 0) {
      console.log(`[${jobId}] Replacing ${Object.keys(imageUrlMap).length} image placeholders with URLs`);
      let sceneDataStr = JSON.stringify(sceneData);
      for (const [placeholder, url] of Object.entries(imageUrlMap)) {
        sceneDataStr = sceneDataStr.split(placeholder).join(url);
      }
      sceneData = JSON.parse(sceneDataStr);
    }

    // Ensure totalDuration matches target
    let totalDuration = sceneData.scenes.reduce((sum, s) => sum + (s.duration || 60), 0);
    if (totalDuration !== targetFrames && totalDuration > 0) {
      const scale = targetFrames / totalDuration;
      for (const scene of sceneData.scenes) {
        scene.duration = Math.max(1, Math.round(scene.duration * scale));
      }
      totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
      sceneData.totalDuration = totalDuration;
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKey = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKey) {
          console.log(`[${jobId}] 🎬 Fetching GIFs for: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifs = await searchGiphy(term, 1);
              if (gifs.length > 0) {
                const gif = gifs[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    animation: 'pop',
                  });
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed for "${term}"`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          } else if (!scene.content.gifLayout) {
            scene.content.gifLayout = 'scattered';
          }
        }
      }
    }

    // Step 2: Write props to JSON file
    const propsDir = session ? session.dir : join(TEMP_DIR, 'remotion-render', jobId);
    mkdirSync(propsDir, { recursive: true });

    const propsPath = join(propsDir, `remotion-props-${jobId}.json`);
    const outputPath = join(propsDir, `remotion-output-${jobId}.mp4`);
    const thumbPath = join(propsDir, `remotion-thumb-${jobId}.jpg`);

    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Step 3: Render with Remotion CLI using DynamicAnimation (the working approach)
    console.log(`[${jobId}] Rendering with Remotion...`);

    const remotionArgs = [
      'remotion', 'render',
      'src/remotion/index.tsx',
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${totalDuration - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
      '--gl=angle',
    ];

    await new Promise((resolve, reject) => {
      const proc = spawn(NPX_CMD, remotionArgs, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log(`[${jobId}] Remotion: ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Remotion render failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Remotion: ${err.message}`));
      });
    });

    const renderTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Render complete in ${renderTime}s`);

    // Check if output exists
    if (!existsSync(outputPath)) {
      throw new Error('Render completed but output file not found');
    }

    // Generate thumbnail
    try {
      await runFFmpeg([
        '-y', '-i', outputPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    // Clean up props file
    try {
      unlinkSync(propsPath);
    } catch (e) {}

    // If we have a session, save as asset
    if (session) {
      const assetId = randomUUID();
      const assetPath = join(session.assetsDir, `${assetId}.mp4`);
      const assetThumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

      // Copy to session assets
      const fs = await import('fs/promises');
      await fs.copyFile(outputPath, assetPath);
      if (existsSync(thumbPath)) {
        await fs.copyFile(thumbPath, assetThumbPath);
      }

      const stats = await fs.stat(assetPath);
      const durationInSeconds = totalDuration / fps;

      const asset = {
        id: assetId,
        type: 'video',
        filename: `remotion-animation-${Date.now()}.mp4`,
        path: assetPath,
        thumbPath: existsSync(assetThumbPath) ? assetThumbPath : null,
        duration: durationInSeconds,
        size: stats.size,
        width,
        height,
        fps,
        createdAt: Date.now(),
        aiGenerated: true,
        generatedBy: 'remotion-prompt',
      };

      session.assets.set(assetId, asset);
      saveAssetMetadata(session);

      console.log(`[${jobId}] Saved asset: ${asset.filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`[${jobId}] === REMOTION RENDER COMPLETE ===\n`);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        success: true,
        asset: {
          id: assetId,
          filename: asset.filename,
          duration: durationInSeconds,
          width,
          height,
          thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
          streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
        },
        renderTime: parseFloat(renderTime),
        sceneCount: sceneData.scenes.length,
      }));
    } else {
      // No session - return the video as a download
      const videoData = readFileSync(outputPath);
      const durationInSeconds = totalDuration / fps;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="remotion-animation-${jobId}.mp4"`,
        'Content-Length': videoData.length,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(videoData);

      // Cleanup temp files
      try {
        unlinkSync(outputPath);
        if (existsSync(thumbPath)) unlinkSync(thumbPath);
      } catch (e) {}
    }

    console.log(`[${jobId}] === REMOTION RENDER FROM PROMPT COMPLETE ===\n`);

  } catch (error) {
    console.error('Remotion render error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Extract audio from video - creates separate audio asset and mutes the video
async function handleExtractAudio(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId } = body;

    if (!assetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'assetId is required' }));
      return;
    }

    const videoAsset = session.assets.get(assetId);
    if (!videoAsset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
      return;
    }

    if (videoAsset.type !== 'video') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset must be a video' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === EXTRACT AUDIO ===`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Generate IDs and paths
    const audioAssetId = randomUUID();
    const mutedVideoAssetId = randomUUID();
    const audioPath = join(session.assetsDir, `${audioAssetId}.mp3`);
    const mutedVideoPath = join(session.assetsDir, `${mutedVideoAssetId}.mp4`);
    const mutedThumbPath = join(session.assetsDir, `${mutedVideoAssetId}_thumb.jpg`);

    // Step 1: Extract audio from video
    console.log(`[${jobId}] Step 1: Extracting audio...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn',                    // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-q:a', '2',              // High quality
      audioPath
    ], jobId);

    // Step 2: Create muted version of video
    console.log(`[${jobId}] Step 2: Creating muted video...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-an',                    // No audio
      '-c:v', 'copy',           // Copy video stream (fast)
      mutedVideoPath
    ], jobId);

    // Step 3: Generate thumbnail for muted video
    try {
      await runFFmpeg([
        '-y', '-i', mutedVideoPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        mutedThumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    // Get file stats
    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    const videoStats = await stat(mutedVideoPath);

    // Get audio duration
    let audioDuration = videoAsset.duration;
    try {
      const durationStr = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
        { encoding: 'utf-8' }
      ).trim();
      audioDuration = parseFloat(durationStr) || videoAsset.duration;
    } catch (e) {
      console.warn(`[${jobId}] Could not get audio duration:`, e.message);
    }

    // Create audio asset
    const audioAsset = {
      id: audioAssetId,
      type: 'audio',
      filename: `${videoAsset.filename.replace(/\.[^.]+$/, '')}-audio.mp3`,
      path: audioPath,
      thumbPath: null,
      duration: audioDuration,
      size: audioStats.size,
      createdAt: Date.now(),
      sourceAssetId: assetId,
    };
    session.assets.set(audioAssetId, audioAsset);

    // Create muted video asset
    const mutedAsset = {
      id: mutedVideoAssetId,
      type: 'video',
      filename: `${videoAsset.filename.replace(/\.[^.]+$/, '')}-muted.mp4`,
      path: mutedVideoPath,
      thumbPath: existsSync(mutedThumbPath) ? mutedThumbPath : videoAsset.thumbPath,
      duration: videoAsset.duration,
      size: videoStats.size,
      width: videoAsset.width || 1920,
      height: videoAsset.height || 1080,
      createdAt: Date.now(),
      sourceAssetId: assetId,
      isMuted: true,
    };
    session.assets.set(mutedVideoAssetId, mutedAsset);

    console.log(`[${jobId}] ✓ Audio extracted: ${audioAsset.filename} (${audioDuration.toFixed(2)}s)`);
    console.log(`[${jobId}] ✓ Muted video created: ${mutedAsset.filename}`);
    console.log(`[${jobId}] === EXTRACT AUDIO COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      audioAsset: {
        id: audioAssetId,
        filename: audioAsset.filename,
        duration: audioDuration,
        type: 'audio',
        streamUrl: `/session/${sessionId}/assets/${audioAssetId}/stream`,
      },
      mutedVideoAsset: {
        id: mutedVideoAssetId,
        filename: mutedAsset.filename,
        duration: mutedAsset.duration,
        type: 'video',
        streamUrl: `/session/${sessionId}/assets/${mutedVideoAssetId}/stream`,
        thumbnailUrl: `/session/${sessionId}/assets/${mutedVideoAssetId}/thumbnail`,
      },
      originalAssetId: assetId,
    }));

  } catch (error) {
    console.error('Extract audio error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Process asset with FFmpeg command (for AI-suggested edits)
async function handleProcessAsset(req, res, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId } = body;
    let command = body.command;

    if (!assetId || !command) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'assetId and command are required' }));
      return;
    }

    const asset = session.assets.get(assetId);
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
      return;
    }

    // Verify the asset file actually exists on disk
    if (!existsSync(asset.path)) {
      console.error(`[ProcessAsset] Asset file missing: ${asset.path}`);
      res.writeHead(410, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        error: 'Asset file no longer exists. The session may have expired. Please re-upload your video.',
        code: 'ASSET_FILE_MISSING'
      }));
      return;
    }

    const jobId = randomUUID();
    // Use a temp path then rename over the original so clips don't need updating
    const tempId = randomUUID();
    const outputPath = join(session.assetsDir, `${tempId}.mp4`);
    const thumbPath = asset.thumbPath || join(session.assetsDir, `${assetId}_thumb.jpg`);

    console.log(`\n[${jobId}] === PROCESS ASSET WITH FFMPEG ===`);
    console.log(`[${jobId}] Source: ${asset.filename}`);
    console.log(`[${jobId}] Command: ${command}`);

    // Auto-fix split/asplit filter output count.
    // Gemini often generates `split[a][b][c]` but the filter defaults to 2 outputs.
    // We count the bracketed labels and inject `=N` when it's missing.
    command = command.replace(/\b(a?split)\b((?:\[[^\]]+\]){2,})/g, (match, filterName, labelStr) => {
      const labels = (labelStr.match(/\[[^\]]+\]/g) || []);
      if (labels.length > 2) {
        return `${filterName}=${labels.length}${labelStr}`;
      }
      return match;
    });

    // Fix zoompan d=N (N > 1): d is "output frames per input frame" — d=500 on a
    // 12-min video generates 500 × frames = ~121 hours of output. For smooth
    // continuous animation using the `on` counter, d=1 is always correct.
    command = command.replace(/zoompan=([^";\n]*?)d=(\d+)/g, (match, params, d) => {
      if (parseInt(d, 10) > 1) {
        console.log(`[${jobId}] Fixed zoompan d=${d}→1 (was generating ${d} frames per input frame)`);
        return `zoompan=${params}d=1`;
      }
      return match;
    });

    // Remove large intermediate upscale before zoompan (e.g. scale=8000:-1,zoompan).
    // Upscaling a 1080p video to 8000px just for zoom quality is ~17× slower with
    // negligible visual benefit for standard 1920×1080 output.
    command = command.replace(/scale=\d{4,}:-\d+,(\s*zoompan)/g, '$1');

    // Replace zoompan=... with equivalent scale+crop.
    // zoompan with expression-based x/y coordinates consistently produces frame=0 on
    // this FFmpeg build (Windows) — the filter initialises but emits no output frames.
    // scale+crop achieves the same visual result and is battle-tested reliable.
    //
    //   zoompan=z=Z:x=XEXPR:y=YEXPR:d=1[:s=WxH]
    //   →  scale=iw*Z:ih*Z, crop=W:H:x='(in_w-W)*t/D':y='(in_h-H)*(1-t/D)'
    //
    // The crop pans diagonally (top-left → bottom-right) over duration D seconds,
    // which matches the typical "slow diagonal pan" intent Gemini requests.
    const replaceZoompanInVf = (vf, duration) => {
      if (!vf || !vf.includes('zoompan')) return vf;

      // Quote-aware extraction: scan char-by-char so commas inside 'min(1.8, ...)' are
      // not treated as filter separators (a plain [^,;]+ regex stops at those commas).
      const zpStart = vf.indexOf('zoompan=');
      if (zpStart === -1) return vf;
      let i = zpStart + 'zoompan='.length;
      let inQuote = false;
      while (i < vf.length) {
        const c = vf[i];
        if (c === "'") { inQuote = !inQuote; }
        else if (!inQuote && (c === ',' || c === ';' || c === '[')) { break; }
        i++;
      }
      const zpParams = vf.substring(zpStart + 'zoompan='.length, i);

      // Extract z (zoom factor). Try bare number first, then first number inside quotes.
      const zNumM = zpParams.match(/(?:^|:)z=([\d.]+)/);
      const zExprM = zpParams.match(/(?:^|:)z='[^']*?([\d.]+)/);
      const rawZ = zNumM ? parseFloat(zNumM[1]) : zExprM ? parseFloat(zExprM[1]) : 1.8;
      // Enforce minimum 1.6 — 1.2x is imperceptible; 1.6–2.0x is cinematic.
      const zVal = Math.max(rawZ, 1.6);

      // Extract output dimensions from s=WxH (default 1920x1080).
      const sM = zpParams.match(/:s=(\d+)x(\d+)/);
      const outW = sM ? parseInt(sM[1]) : 1920;
      const outH = sM ? parseInt(sM[2]) : 1080;

      const d = Math.max(duration, 0.1);

      // Detect intent: CENTER ZOOM if zoompan x/y expression uses `zoom` as a variable
      // for centering (e.g. x='iw/2-(iw/zoom)/2'). DIRECTIONAL PAN otherwise.
      // Also detect short variable 'z' used as zoom divisor for centering: iw/2-(iw/z/2)
      const isCenterZoom = zpParams.includes('/zoom') || zpParams.includes('zoom/')
        || zpParams.includes('iw/z') || zpParams.includes('ih/z')
        || zpParams.includes('/z/') || zpParams.includes('/z)');

      let replacement;
      if (isCenterZoom) {
        // Progressive center zoom: crop a shrinking centred window, scale back to outWxoutH.
        // Zoom factor ramps from 1.0 at t=0 to zVal at t=d.
        // crop w/h are time-varying expressions; x/y always centre the crop window.
        const zoomRate = ((zVal - 1) / d).toFixed(6);
        replacement = `crop=w='iw/(1+${zoomRate}*t)':h='ih/(1+${zoomRate}*t)':x='(in_w-out_w)/2':y='(in_h-out_h)/2',scale=${outW}:${outH}`;
        console.log(`[${jobId}] zoompan→center zoom (1x→${zVal}x over ${d}s)`);
      } else {
        // Directional pan: scale up by zVal, then slide crop window diagonally.
        replacement = `scale=iw*${zVal}:ih*${zVal},crop=${outW}:${outH}:x='min((in_w-${outW})*t/${d},in_w-${outW})':y='max((in_h-${outH})*(1-t/${d}),0)'`;
        console.log(`[${jobId}] zoompan→diagonal pan (z=${zVal} over ${d}s)`);
      }

      // Strip any large preceding upscale (e.g. scale=8000:-1) that was paired with zoompan
      const leadingScaleRe = /scale=\d{4,}:-?\d+,\s*$/;
      const beforeZp = vf.substring(0, zpStart);
      const leadingM = beforeZp.match(leadingScaleRe);
      const replStart = leadingM ? zpStart - leadingM[0].length : zpStart;
      return vf.substring(0, replStart) + replacement + vf.substring(i);
    };

    // Apply zoompan→scale+crop replacement to plain -vf commands (no range detection)
    // so simple "add zoom" prompts also work reliably.
    // IMPORTANT: skip this when the command has -ss + -to — those go through
    // buildRangedConcat which calls replaceZoompanInVf with the correct segment
    // duration (t1-t0). Running it here first would bake in asset.duration (e.g. 727s)
    // so a 30-second segment barely moves over its actual duration.
    {
      const simpleVfM = command.match(/-vf\s+"([^"]+)"/);
      const isRangedCmd = /-ss\s+[\d:.]+/.test(command) && /(?:^|\s)-to\s+[\d:.]+/.test(command);
      if (simpleVfM && simpleVfM[1].includes('zoompan') && !command.includes('-filter_complex') && !isRangedCmd) {
        const newVf = replaceZoompanInVf(simpleVfM[1], asset.duration || 60);
        command = command.replace(/-vf\s+"[^"]+"/, `-vf "${newVf}"`);
      }
    }

    // Helper: rebuild a ranged effect as a multi-input concat.
    // Uses separate -i input.mp4 instances with -ss/-t seeking for each segment so
    // each gets its own clean decode context. This avoids the trim-filter PTS/format
    // bugs that cause the after-segment to freeze on the last effect frame.
    const parseTs = (s) => {
      const parts = s.split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parseFloat(s);
    };
    const buildRangedConcat = (t0, t1, vf, af) => {
      const dur = asset.duration || 0;
      // Guard: range entirely past end → apply effect to whole video
      if (dur > 0 && t0 >= dur - 0.1) {
        console.log(`[${jobId}] Ranged t0=${t0}s >= duration=${dur}s — effect applied to whole video`);
        const cmd = `ffmpeg -y -i input.mp4${vf ? ` -vf "${vf}"` : ''}${af ? ` -af "${af}"` : ''} -c:v libx264 -c:a aac output.mp4`;
        return cmd;
      }
      const hasPrefix = t0 > 0.05;
      const hasSuffix = dur > 0 ? t1 < dur - 0.1 : true;

      // Fix rotate canvas expansion (would cause dimension mismatch in concat)
      if (vf.match(/\brotate\b/) && !vf.includes('ow=')) {
        vf = vf.replace(/(\brotate=[^,\s]+)/, '$1:ow=iw:oh=ih');
      }

      // NB_FRAMES is unavailable inside filter_complex (evaluates to 0), turning
      // expressions like n/(NB_FRAMES-1) into n/(-1) → huge negative crop coords → zero output.
      // Replace with the actual segment frame count before building the filter graph.
      if (vf.includes('NB_FRAMES')) {
        const frameCount = Math.round((t1 - t0) * (asset.fps || 30));
        vf = vf.replace(/NB_FRAMES/g, String(frameCount));
      }

      // Transition effects (whip pan, flash, etc.) — auto-cap to 0.8s and centre on t0.
      // avgblur with large sizeX is a horizontal smear/whip pan effect. Applying it for
      // 20 seconds produces a long blurry segment, not a transition. Cap it so the blur
      // fires only for 0.8s at the start of the user's specified range, then the video
      // resumes normally. This is the correct cinematic behaviour for a whip pan.
      const sizeXMatch = vf.match(/avgblur[^,]*sizeX=(\d+)/);
      const isTransitionEffect = sizeXMatch && parseInt(sizeXMatch[1]) >= 100;
      if (isTransitionEffect && (t1 - t0) > 1.0) {
        console.log(`[${jobId}] Transition effect (avgblur sizeX=${sizeXMatch[1]}) — auto-capping from ${(t1-t0).toFixed(1)}s to 0.8s`);
        t1 = t0 + 0.8;
      }

      // Replace zoompan with scale+crop (zoompan produces frame=0 in filter_complex
      // with expression-based coordinates on this FFmpeg build).
      vf = replaceZoompanInVf(vf, t1 - t0);

      // Build list of input file references with seek params.
      // Multiple -i input.mp4 entries — the tokenizer replaces each with asset.path.
      const inputArgs = [];
      const filterParts = [];
      const segInputs = [];
      let iIdx = 0; // input index
      let sIdx = 0; // segment index

      // All segments must share the same pixel format AND dimensions for concat to work.
      // - format=yuv420p: phone video is often yuvj420p; scale/crop output yuv420p
      // - scaleNorm: if the effect's vf includes scale=W:H or crop=W:H with numeric
      //   dimensions, apply the same scale to before/after so all segments match.
      // - format=yuv420p BEFORE user's filters: normalise input pixel format first.
      // aformat=sample_fmts=fltp normalises audio sample format for concat.
      //
      // Check scale= AND crop= for numeric output dimensions (last one wins —
      // that is the final output resolution of the effect segment).
      const allSizeMatches = [...(vf || '').matchAll(/\b(?:scale|crop)=(\d+):(\d+)\b/g)];
      const lastSize = allSizeMatches.length > 0 ? allSizeMatches[allSizeMatches.length - 1] : null;
      const scaleNorm = lastSize ? `scale=${lastSize[1]}:${lastSize[2]},` : '';

      if (hasPrefix) {
        inputArgs.push(`-t ${t0} -i input.mp4`);
        filterParts.push(`[${iIdx}:v]setpts=PTS-STARTPTS,${scaleNorm}format=yuv420p[v${sIdx}]`);
        filterParts.push(`[${iIdx}:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp[a${sIdx}]`);
        segInputs.push(`[v${sIdx}][a${sIdx}]`); iIdx++; sIdx++;
      }

      inputArgs.push(`-ss ${t0} -t ${t1 - t0} -i input.mp4`);
      // format=yuv420p injected before AND after user's filter chain:
      // before = normalise input for filters like zoompan that require yuv420p
      // after  = normalise output so concat dimensions/format match before/after segments
      const midV = vf ? `setpts=PTS-STARTPTS,format=yuv420p,${vf},format=yuv420p` : `setpts=PTS-STARTPTS,${scaleNorm}format=yuv420p`;
      const midA = af ? `asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp,${af}` : `asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp`;
      filterParts.push(`[${iIdx}:v]${midV}[v${sIdx}]`);
      filterParts.push(`[${iIdx}:a]${midA}[a${sIdx}]`);
      segInputs.push(`[v${sIdx}][a${sIdx}]`); iIdx++; sIdx++;

      if (hasSuffix) {
        inputArgs.push(`-ss ${t1} -i input.mp4`);
        filterParts.push(`[${iIdx}:v]setpts=PTS-STARTPTS,${scaleNorm}format=yuv420p[v${sIdx}]`);
        filterParts.push(`[${iIdx}:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp[a${sIdx}]`);
        segInputs.push(`[v${sIdx}][a${sIdx}]`); iIdx++; sIdx++;
      }

      const n = segInputs.length;
      filterParts.push(`${segInputs.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);
      const cmd = `ffmpeg -y ${inputArgs.join(' ')} -filter_complex "${filterParts.join('; ')}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac output.mp4`;
      console.log(`[${jobId}] Ranged effect (${t0}s–${t1}s) → ${n}-part multi-input concat: ${cmd}`);
      return cmd;
    };

    // Pattern 1: Gemini uses -ss + -to + -vf/-af (extracts only that segment)
    const ssM = command.match(/-ss\s+([\d:.]+)/);
    const toM = command.match(/(?:^|\s)-to\s+([\d:.]+)/);
    const vfM = command.match(/-vf\s+"([^"]+)"/);
    const afM = command.match(/-af\s+"([^"]+)"/);
    const hasAnFlag = /-an\b/.test(command);

    if (ssM && toM && (vfM || afM) && !hasAnFlag && !command.includes('-filter_complex')) {
      const t0 = parseTs(ssM[1]);
      const t1 = parseTs(toM[1]);
      command = buildRangedConcat(t0, t1, vfM ? vfM[1] : '', afM ? afM[1] : '');
    }

    // Pattern 2: Gemini uses enable='between(t,T0,T1)' inside -vf (unsupported by most filters)
    if (!command.includes('-filter_complex') && !ssM) {
      const enableMatch = command.match(/enable='between\(t,([\d.]+),([\d.]+)\)'/);
      const vfRawMatch = command.match(/-vf\s+"([^"]+)"/);
      if (enableMatch && vfRawMatch) {
        const t0e = parseFloat(enableMatch[1]);
        const t1e = parseFloat(enableMatch[2]);
        // Strip enable clause and fix (t-T0) → t since each segment's t resets to 0
        let cleanVf = vfRawMatch[1]
          .replace(/:?enable='between\(t,[^)]+\)'/, '')
          .replace(new RegExp(`\\(t-${t0e}\\)`, 'g'), 't');
        command = buildRangedConcat(t0e, t1e, cleanVf, '');
      }
    }

    // Ensure explicit codec flags for filter_complex commands targeting mp4 output.
    // Without -c:v/-c:a, FFmpeg auto-selects but fails to init the AAC encoder
    // (EINVAL / "Invalid argument") on some builds when receiving filtered streams.
    if (/-filter_complex\b/.test(command) && /output\.mp4/.test(command)) {
      if (!/-c:v\b/.test(command) && !/-codec:v\b/.test(command)) {
        command = command.replace(/output\.mp4/, '-c:v libx264 -c:a aac output.mp4');
        console.log(`[${jobId}] Added codec flags to filter_complex command`);
      }
    }

    // Parse the FFmpeg command and replace input/output placeholders.
    // Use a shell-aware tokenizer so quoted filter strings (e.g. "afftdn=nf=-25")
    // are kept as single args, and paths are inserted WITHOUT extra quotes
    // (spawn takes an args array, not a shell string — no quoting needed).
    const tokenizeCommand = (cmd) => {
      const tokens = [];
      let cur = '';
      let inQuote = false;
      let quoteChar = '';
      for (const ch of cmd) {
        if (inQuote) {
          if (ch === quoteChar) { inQuote = false; }
          else { cur += ch; }
        } else if (ch === '"' || ch === "'") {
          inQuote = true; quoteChar = ch;
        } else if (ch === ' ' || ch === '\t') {
          if (cur.length) { tokens.push(cur); cur = ''; }
        } else {
          cur += ch;
        }
      }
      if (cur.length) tokens.push(cur);
      return tokens;
    };

    const rawCommand = command.replace(/^ffmpeg\s+/i, '');
    let ffmpegArgs = tokenizeCommand(rawCommand)
      .map(arg => {
        if (/^"?input\.mp4"?$/i.test(arg)) return asset.path;
        if (/^"?output\.mp4"?$/i.test(arg)) return outputPath;
        return arg;
      });

    // If the command doesn't reference the actual asset path, reconstruct it
    if (!ffmpegArgs.some(arg => arg === asset.path)) {
      ffmpegArgs = ['-i', asset.path, ...ffmpegArgs.filter(a => a !== '-i'), outputPath];
    }

    // Ensure -y flag for overwrite
    if (!ffmpegArgs.includes('-y')) {
      ffmpegArgs.unshift('-y');
    }

    console.log(`[${jobId}] FFmpeg args:`, ffmpegArgs);

    await runFFmpeg(ffmpegArgs, jobId);

    // On Windows, the browser holds a read lock on the original file while streaming,
    // so renameSync over it fails with EPERM. Instead, update asset.path to point to
    // the new output file — same assetId, different physical file on disk.
    // The old file is left as an orphan (no longer referenced by the session).

    // Regenerate thumbnail from the new output file
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Update asset metadata — path now points to the new output file
    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    let duration = asset.duration;
    try {
      const durationStr = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`,
        { encoding: 'utf-8' }
      ).trim();
      duration = parseFloat(durationStr) || asset.duration;
    } catch (e) {
      console.warn(`[${jobId}] Could not get duration:`, e.message);
    }

    // Update the existing asset entry — same assetId, path now points to the edited file
    session.assets.set(assetId, {
      ...asset,
      path: outputPath,
      duration,
      size: stats.size,
      thumbPath,
      editCount: (asset.editCount || 0) + 1,
      lastEditCommand: command,
    });

    await saveAssetMetadata(session);

    console.log(`[${jobId}] Asset edited in-place: ${assetId} (${duration.toFixed(2)}s)`);
    console.log(`[${jobId}] === PROCESSING COMPLETE ===
`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Process asset error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== SERVER ==============

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Session-based routes (new efficient API)
  const sessionMatch = path.match(/^\/session\/([^/]+)(\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const action = sessionMatch[3] || '';

    if (req.method === 'POST' && sessionId === 'create') {
      await handleSessionCreate(req, res);
    } else if (req.method === 'POST' && sessionId === 'upload') {
      await handleSessionUpload(req, res);
    } else if (req.method === 'GET' && action === 'stream') {
      await handleSessionStream(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'info') {
      await handleSessionInfo(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'download') {
      await handleSessionDownload(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'process') {
      await handleSessionProcess(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'remove-dead-air') {
      await handleSessionRemoveDeadAir(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'chapters') {
      await handleSessionChapters(req, res, sessionId);
    } else if (req.method === 'DELETE' && !action) {
      handleSessionDelete(req, res, sessionId);
    }
    // Multi-asset endpoints
    else if (req.method === 'POST' && action === 'assets') {
      await handleAssetUpload(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'assets') {
      handleAssetList(req, res, sessionId);
    } else if (action.startsWith('assets/')) {
      const assetPath = action.substring(7); // Remove 'assets/'
      const [assetId, subAction] = assetPath.split('/');

      if (req.method === 'DELETE' && !subAction) {
        handleAssetDelete(req, res, sessionId, assetId);
      } else if (req.method === 'GET' && subAction === 'thumbnail') {
        await handleAssetThumbnail(req, res, sessionId, assetId);
      } else if (req.method === 'GET' && subAction === 'stream') {
        await handleAssetStream(req, res, sessionId, assetId);
      } else if (req.method === 'GET' && subAction === 'waveform') {
        await handleAssetWaveform(req, res, sessionId, assetId, url);
      } else if (req.method === 'GET' && !subAction && (assetId.endsWith('.jpg') || assetId.endsWith('.png'))) {
        // Serve static image files from assets directory (e.g., scene thumbnails)
        const session = getSession(sessionId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        const filePath = join(session.assetsDir, assetId);
        if (existsSync(filePath)) {
          const ext = assetId.endsWith('.png') ? 'png' : 'jpeg';
          res.writeHead(200, {
            'Content-Type': `image/${ext}`,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
          });
          createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'File not found' }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset endpoint not found' }));
      }
    }
    // Project state endpoints
    else if (req.method === 'GET' && action === 'project') {
      handleProjectGet(req, res, sessionId);
    } else if (req.method === 'PUT' && action === 'project') {
      await handleProjectSave(req, res, sessionId);
    }
    // Render endpoints
    else if (req.method === 'POST' && action === 'render') {
      await handleProjectRender(req, res, sessionId);
    }
    // GIF creation
    else if (req.method === 'POST' && action === 'create-gif') {
      await handleCreateGif(req, res, sessionId);
    }
    // Simple transcription (for captions)
    else if (req.method === 'POST' && action === 'transcribe') {
      await handleTranscribe(req, res, sessionId);
    }
    // Transcription and keyword extraction
    else if (req.method === 'POST' && action === 'transcribe-and-extract') {
      await handleTranscribeAndExtract(req, res, sessionId);
    }
    // B-roll image generation
    else if (req.method === 'POST' && action === 'generate-broll') {
      await handleGenerateBroll(req, res, sessionId);
    }
    // Motion graphics rendering (placeholder - creates solid color video for now)
    else if (req.method === 'POST' && action === 'render-motion-graphic') {
      await handleRenderMotionGraphic(req, res, sessionId);
    }
    // AI-generated custom animation (uses Gemini + Remotion)
    else if (req.method === 'POST' && action === 'generate-animation') {
      await handleGenerateAnimation(req, res, sessionId);
    }
    // Analyze video for animation (returns concept for approval, no rendering)
    else if (req.method === 'POST' && action === 'analyze-for-animation') {
      await handleAnalyzeForAnimation(req, res, sessionId);
    }
    // Render from pre-approved concept (skips analysis)
    else if (req.method === 'POST' && action === 'render-from-concept') {
      await handleRenderFromConcept(req, res, sessionId);
    }
    // Contextual animation - analyzes video content first, then generates relevant animation
    else if (req.method === 'POST' && action === 'generate-contextual-animation') {
      await handleGenerateContextualAnimation(req, res, sessionId);
    }
    // Transcript animation - kinetic typography from speech
    else if (req.method === 'POST' && action === 'generate-transcript-animation') {
      await handleGenerateTranscriptAnimation(req, res, sessionId);
    }
    // Edit existing animation with new prompt
    else if (req.method === 'POST' && action === 'edit-animation') {
      await handleEditAnimation(req, res, sessionId);
    }
    // Generate image with fal.ai (Picasso agent)
    else if (req.method === 'POST' && action === 'generate-image') {
      await handleGenerateImage(req, res, sessionId);
    }
    // Generate batch animations across timeline
    else if (req.method === 'POST' && action === 'generate-batch-animations') {
      await handleGenerateBatchAnimations(req, res, sessionId);
    }
    // Process asset with FFmpeg command
    else if (req.method === 'POST' && action === 'process-asset') {
      await handleProcessAsset(req, res, sessionId);
    }
    // Extract audio from video (creates audio asset + muted video)
    else if (req.method === 'POST' && action === 'extract-audio') {
      await handleExtractAudio(req, res, sessionId);
    }
    // Scene detection - detect visual scene changes
    else if (req.method === 'POST' && action === 'scene-detect') {
      await handleSceneDetect(req, res, sessionId);
    }
    // Smart scene analysis - transcript + visual analysis for topic-based scenes
    else if (req.method === 'POST' && action === 'analyze-scenes') {
      await handleAnalyzeScenes(req, res, sessionId);
    }
    // Export a single scene as separate video file
    else if (req.method === 'POST' && action === 'export-scene') {
      await handleExportScene(req, res, sessionId);
    }
    // B-Roll suggestions - analyze transcript for visual overlay opportunities
    else if (req.method === 'POST' && action === 'suggest-broll') {
      await handleSuggestBroll(req, res, sessionId);
    }
    // Apply B-roll suggestion - download/generate and register asset
    else if (req.method === 'POST' && action === 'apply-broll') {
      await handleApplyBrollSuggestion(req, res, sessionId);
    }
    // Analyze emphasis points for viral zoom cuts
    else if (req.method === 'POST' && action === 'analyze-emphasis') {
      await handleAnalyzeEmphasis(req, res, sessionId);
    }
    // Detect slow sections for cutting
    else if (req.method === 'POST' && action === 'detect-slow-sections') {
      await handleDetectSlowSections(req, res, sessionId);
    }
    // Analyze video for short candidates with virality scoring
    else if (req.method === 'POST' && action === 'analyze-for-shorts') {
      await handleAnalyzeForShorts(req, res, sessionId);
    }
    // Export a single short with 9:16 crop
    else if (req.method === 'POST' && action === 'export-short') {
      await handleExportShort(req, res, sessionId);
    }
    // Mute specific time segments (for filler word audio removal)
    else if (req.method === 'POST' && action === 'mute-segments') {
      await handleMuteSegments(req, res, sessionId);
    }
    // Resequence sections based on captions (move X before Y)
    else if (req.method === 'POST' && action === 'resequence') {
      await handleResequence(req, res, sessionId);
    }
    // Auto-Reframe: crop + scale to reframe subject
    else if (req.method === 'POST' && action === 'auto-reframe') {
      await handleAutoReframe(req, res, sessionId);
    }
    // Auto-Duck: duck background music under speech
    else if (req.method === 'POST' && action === 'auto-duck') {
      await handleAutoDuck(req, res, sessionId);
    }
    // Silence Preview: return silence segments without cutting
    else if (req.method === 'POST' && action === 'silence-preview') {
      await handleSilencePreview(req, res, sessionId);
    }
    // Highlight Reel: compile best moments
    else if (req.method === 'POST' && action === 'highlight-reel') {
      await handleHighlightReel(req, res, sessionId);
    }
    // Caption Translation: translate captions to target language
    else if (req.method === 'POST' && action === 'translate-captions') {
      await handleTranslateCaptions(req, res, sessionId);
    }
    // Thumbnail Generator: extract frame as image asset
    else if (req.method === 'POST' && action === 'generate-thumbnail') {
      await handleGenerateThumbnail(req, res, sessionId);
    }
    // YouTube Thumbnail Generator: AI-powered thumbnail with variants
    else if (req.method === 'POST' && action === 'generate-youtube-thumbnail') {
      await handleGenerateYoutubeThumbnail(req, res, sessionId);
    }
    // Waveform Data: extract RMS amplitude array for UI display
    else if (req.method === 'POST' && action === 'waveform-data') {
      await handleWaveformData(req, res, sessionId);
    }
    // Generate video from image (DiCaprio agent)
    else if (req.method === 'POST' && action === 'generate-video') {
      await handleGenerateVideo(req, res, sessionId);
    }
    // Restyle video with AI (DiCaprio agent - LTX-2)
    else if (req.method === 'POST' && action === 'restyle-video') {
      await handleRestyleVideo(req, res, sessionId);
    }
    // Remove video background (DiCaprio agent - Bria)
    else if (req.method === 'POST' && action === 'remove-video-bg') {
      await handleRemoveVideoBg(req, res, sessionId);
    }
    // Generate Remotion composition code from prompt
    else if (req.method === 'POST' && action === 'generate-remotion') {
      await handleGenerateRemotion(req, res, sessionId);
    }
    // Render Remotion code to video asset
    else if (req.method === 'POST' && action === 'render-remotion') {
      await handleRenderRemotion(req, res, sessionId);
    }
    // GIPHY search endpoints
    else if (req.method === 'GET' && action === 'giphy/search') {
      await handleGiphySearch(req, res, sessionId, url);
    }
    else if (req.method === 'GET' && action === 'giphy/trending') {
      await handleGiphyTrending(req, res, sessionId, url);
    }
    else if (req.method === 'POST' && action === 'giphy/add') {
      await handleGiphyAdd(req, res, sessionId);
    }
    else if (action.startsWith('renders/')) {
      const renderType = action.substring(8); // Remove 'renders/'
      if (req.method === 'GET') {
        await handleRenderDownload(req, res, sessionId, renderType);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Render endpoint not found' }));
      }
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session endpoint not found' }));
    }
    return;
  }

  // Standalone Remotion generator (no session required)
  if (req.method === 'POST' && path === '/generate-remotion') {
    await handleGenerateRemotionStandalone(req, res);
    return;
  }

  // Standalone Remotion renderer (no session required - returns video download)
  if (req.method === 'POST' && path === '/render-remotion') {
    await handleRenderRemotion(req, res, null);
    return;
  }

  // Legacy routes (kept for backwards compatibility)
  if (req.method === 'POST' && path === '/process') {
    await handleProcess(req, res);
  } else if (req.method === 'POST' && path === '/remove-dead-air') {
    await handleRemoveDeadAir(req, res);
  } else if (req.method === 'POST' && path === '/generate-chapters') {
    await handleGenerateChapters(req, res);
  } else if (req.method === 'POST' && path === '/auto-enhance') {
    await handleAutoEnhance(req, res);
  } else if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ffmpeg: 'native', sessions: sessions.size }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🎬 Local FFmpeg server running at http://localhost:${PORT}`);
  console.log(`\n   Session API:`);
  console.log(`   POST /session/upload - Upload video, get sessionId`);
  console.log(`   GET  /session/:id/stream - Stream video for preview`);
  console.log(`   GET  /session/:id/info - Get video info`);
  console.log(`   POST /session/:id/process - Apply FFmpeg edit`);
  console.log(`   POST /session/:id/remove-dead-air - Remove silence`);
  console.log(`   POST /session/:id/chapters - Generate chapters`);
  console.log(`   POST /auto-enhance - FrameForge transcript intelligence`);
  console.log(`   GET  /session/:id/download - Download final video`);
  console.log(`   DELETE /session/:id - Clean up session`);
  console.log(`\n   Multi-Asset API:`);
  console.log(`   POST /session/:id/assets - Upload asset (video/image/audio)`);
  console.log(`   GET  /session/:id/assets - List all assets`);
  console.log(`   DELETE /session/:id/assets/:assetId - Delete asset`);
  console.log(`   GET  /session/:id/assets/:assetId/thumbnail - Get thumbnail`);
  console.log(`   GET  /session/:id/assets/:assetId/stream - Stream asset`);
  console.log(`\n   Project API:`);
  console.log(`   GET  /session/:id/project - Get project state`);
  console.log(`   PUT  /session/:id/project - Save project state`);
  console.log(`   POST /session/:id/render - Render project to video`);
  console.log(`   GET  /session/:id/renders/preview - Download preview`);
  console.log(`   GET  /session/:id/renders/export - Download export`);
  console.log(`\n   AI/Auto GIF API:`);
  console.log(`   POST /session/:id/transcribe-and-extract - Transcribe video, extract keywords, fetch GIFs`);
  console.log(`   POST /session/:id/generate-broll - Generate AI B-roll images from transcript`);
  console.log(`   POST /session/:id/generate-animation - AI-generated custom animation (Gemini + Remotion)`);
  console.log(`   POST /session/:id/analyze-for-animation - Analyze video, return concept for approval`);
  console.log(`   POST /session/:id/generate-contextual-animation - Content-aware animation (transcribes video first)`);
  console.log(`   POST /session/:id/process-asset - Apply FFmpeg command to an asset`);
  console.log(`\n   GET /health - Health check\n`);
});
