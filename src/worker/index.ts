import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenAI } from "@google/genai";

interface Env {
  GEMINI_API_KEY: string;
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  MOCHA_USERS_SERVICE_API_URL: string;
  MOCHA_USERS_SERVICE_API_KEY: string;
}

// In-memory store for pending requests (dev only)
const pendingRequests = new Map<string, { status: string; result?: any; error?: string }>();

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// Start an AI edit job - returns immediately with a job ID
app.post("/api/ai-edit/start", async (c) => {
  try {
    const body = await c.req.json();
    const prompt = body.prompt;

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const jobId = crypto.randomUUID();
    pendingRequests.set(jobId, { status: "processing" });

    // Process in background using waitUntil
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const ai = new GoogleGenAI({
            apiKey: c.env.GEMINI_API_KEY,
          });

          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
              systemInstruction: `You are a video editing AI assistant that helps users edit their videos using FFmpeg commands.

When the user describes what they want to do with their video, you should:
1. Understand the editing request
2. Generate the appropriate FFmpeg command to accomplish it
3. Explain what the command will do in simple terms

IMPORTANT: Always use "input.mp4" as the input filename and "output.mp4" as the output filename in your commands.

Return your response as valid JSON with exactly this structure:
{"command": "the FFmpeg command", "explanation": "simple explanation"}

Common video editing tasks:
- Remove dead air/silence (removes silent audio AND corresponding video): ffmpeg -y -i input.mp4 -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB,asetpts=N/SR/TB" -vf "setpts=N/FRAME_RATE/TB" -shortest output.mp4
- Trim/cut video from start to end time: ffmpeg -y -i input.mp4 -ss 00:00:10 -to 00:00:30 -c copy output.mp4
- Speed up 1.5x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.667*PTS" -filter:a "atempo=1.5" output.mp4
- Speed up 2x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" output.mp4
- Slow down 0.5x: ffmpeg -y -i input.mp4 -filter:v "setpts=2.0*PTS" -filter:a "atempo=0.5" output.mp4
- Remove audio completely: ffmpeg -y -i input.mp4 -an -c:v copy output.mp4
- Remove background noise from audio: ffmpeg -y -i input.mp4 -af "highpass=f=200,lowpass=f=3000,afftdn=nf=-25" -c:v copy output.mp4
- Resize to 1280x720: ffmpeg -y -i input.mp4 -vf "scale=1280:720" output.mp4
- Resize to 1920x1080: ffmpeg -y -i input.mp4 -vf "scale=1920:1080" output.mp4
- Crop center 640x480: ffmpeg -y -i input.mp4 -vf "crop=640:480" output.mp4
- Rotate 90° clockwise: ffmpeg -y -i input.mp4 -vf "transpose=1" output.mp4
- Rotate 90° counter-clockwise: ffmpeg -y -i input.mp4 -vf "transpose=2" output.mp4
- Increase volume 50%: ffmpeg -y -i input.mp4 -af "volume=1.5" -c:v copy output.mp4
- Decrease volume 50%: ffmpeg -y -i input.mp4 -af "volume=0.5" -c:v copy output.mp4
- Add fade in/out (1 second): ffmpeg -y -i input.mp4 -vf "fade=t=in:st=0:d=1,fade=t=out:st=END-1:d=1" -af "afade=t=in:st=0:d=1,afade=t=out:st=END-1:d=1" output.mp4
- Extract first 30 seconds: ffmpeg -y -i input.mp4 -t 30 -c copy output.mp4
- Remove first 10 seconds: ffmpeg -y -i input.mp4 -ss 10 -c copy output.mp4
- Convert to MP4 (re-encode): ffmpeg -y -i input.mp4 -c:v libx264 -c:a aac output.mp4
- Ken Burns zoom in + pan: ffmpeg -y -i input.mp4 -vf "zoompan=z=2.0:x='(iw-iw/2.0)*t/30':y='(ih-ih/2.0)*t/30':d=1:s=1920x1080" -c:a copy output.mp4
- Dramatic zoom out pan: ffmpeg -y -i input.mp4 -vf "zoompan=z=1.8:x='(iw-iw/1.8)*(1-t/30)':y='(ih-ih/1.8)*(1-t/30)':d=1:s=1920x1080" -c:a copy output.mp4
- Parallax depth / slow zoom in (centered): ffmpeg -y -i input.mp4 -vf "zoompan=z='min(2.0,1.0+(t/30)*1.0)':x='iw/2-(iw/z/2)':y='ih/2-(ih/z/2)':d=1:s=1920x1080" -c:a copy output.mp4
- Whip pan transition (IMPORTANT: use only 0.5s at the exact cut point, the server auto-caps longer ranges): ffmpeg -y -ss START -to START+0.5 -i input.mp4 -vf "avgblur=sizeX=500:sizeY=1,scale=1920:1080" -c:a copy output.mp4
- Camera shake: ffmpeg -y -i input.mp4 -vf "crop=iw-40:ih-40:20+15*sin(t*8):20+10*cos(t*11),scale=iw+40:ih+40" -c:a copy output.mp4
- Slow rotation: ffmpeg -y -i input.mp4 -vf "rotate=PI/180*sin(t)*3:c=none" -c:a copy output.mp4
- Cinematic color grade: ffmpeg -y -i input.mp4 -vf "curves=r='0/0 0.5/0.45 1/0.9':g='0/0.02 0.5/0.48 1/0.95':b='0/0.05 0.5/0.5 1/1'" -c:a copy output.mp4
- Warm color grade: ffmpeg -y -i input.mp4 -vf "colorbalance=rs=0.1:gs=-0.02:bs=-0.1:rm=0.05:gm=0:bm=-0.05" -c:a copy output.mp4
- Cool/blue color grade: ffmpeg -y -i input.mp4 -vf "colorbalance=rs=-0.1:gs=-0.02:bs=0.15:rm=-0.05:gm=0:bm=0.08" -c:a copy output.mp4
- Vintage/sepia tone: ffmpeg -y -i input.mp4 -vf "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131" -c:a copy output.mp4
- Black and white: ffmpeg -y -i input.mp4 -vf "hue=s=0" -c:a copy output.mp4

CRITICAL RULES for generating commands:
1. ALWAYS prefer simple -vf or -af flags over filter_complex. Only use filter_complex when you truly need multiple inputs or complex branching.
2. When you DO use filter_complex with a split or asplit filter, ALWAYS specify the output count: write split=3[a][b][c] NOT split[a][b][c]. The default is 2 — if you omit the count with 3+ labels, FFmpeg will error.
3. Never generate -vf AND a separate -filter_complex in the same command.
4. Use simple filter chains (comma-separated) for single-input effects: -vf "filter1,filter2,filter3"
5. Always use -y flag to overwrite output. Provide safe, valid FFmpeg commands.
6. For time-range effects (e.g. user says "[0:14-0:34] Add pan"): ALWAYS add -ss START_SECONDS -to END_SECONDS before -i input.mp4 (e.g. "ffmpeg -y -ss 14 -to 34 -i input.mp4 -vf ..."). The server automatically converts this to a proper segment concat that preserves the full video. NEVER apply heavy motion filters to the full video when the user specifies a time range.
7. NEVER use enable='between(t,...)' — most motion filters reject it with "Not yet implemented".
8. For zoompan, ALWAYS use d=1. Never use d=N where N > 1 — d=N generates N output frames per input frame, turning a 12-minute video into N×12 minutes of output.
9. NEVER use scale=LARGE:-1 before zoompan (e.g. scale=8000:-1). Processing at 8000px is ~17× slower than 1920px with no visible quality gain for 1080p output.
10. For zoom/pan effects, always use z≥1.6. z=1.2 is barely perceptible. Use z=1.8–2.0 for a clearly visible cinematic effect.
11. For whip pan / transition / motion streak effects: use avgblur=sizeX=500:sizeY=1 and set -to to START+0.5 (0.5 seconds only). NEVER apply a whip pan for more than 1 second — the server auto-caps it to 0.8s. Do NOT use tblend for this.`,
              responseMimeType: "application/json",
            },
          });

          const responseText = response.text || "{}";
          let result;
          try {
            result = JSON.parse(responseText);
          } catch {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            result = jsonMatch
              ? JSON.parse(jsonMatch[0])
              : { command: "", explanation: "Failed to parse response" };
          }

          pendingRequests.set(jobId, { status: "complete", result });
        } catch (error) {
          console.error("AI edit error:", error);
          pendingRequests.set(jobId, {
            status: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      })()
    );

    return c.json({ jobId, status: "processing" });
  } catch (error) {
    console.error("Start job error:", error);
    return c.json({ error: "Failed to start job" }, 500);
  }
});

// Check job status
app.get("/api/ai-edit/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = pendingRequests.get(jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.status === "complete") {
    pendingRequests.delete(jobId); // Clean up
    return c.json({ status: "complete", success: true, ...job.result });
  }

  if (job.status === "error") {
    pendingRequests.delete(jobId); // Clean up
    return c.json({ status: "error", error: job.error });
  }

  return c.json({ status: "processing" });
});

// Legacy endpoint - simple synchronous call (fallback)
app.post("/api/ai-edit", async (c) => {
  try {
    const body = await c.req.json();
    const prompt = body.prompt;

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const ai = new GoogleGenAI({
      apiKey: c.env.GEMINI_API_KEY,
    });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: `You are a video editing AI assistant that helps users edit their videos using FFmpeg commands.

When the user describes what they want to do with their video, you should:
1. Understand the editing request
2. Generate the appropriate FFmpeg command to accomplish it
3. Explain what the command will do in simple terms

IMPORTANT: Always use "input.mp4" as the input filename and "output.mp4" as the output filename in your commands.

Return your response as valid JSON with exactly this structure:
{"command": "the FFmpeg command", "explanation": "simple explanation"}

Common video editing tasks:
- Remove dead air/silence: ffmpeg -y -i input.mp4 -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB,asetpts=N/SR/TB" -vf "setpts=N/FRAME_RATE/TB" -shortest output.mp4
- Trim/cut: ffmpeg -y -i input.mp4 -ss 00:00:10 -to 00:00:30 -c copy output.mp4
- Speed up 2x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" output.mp4
- Remove background noise: ffmpeg -y -i input.mp4 -af "highpass=f=200,lowpass=f=3000,afftdn=nf=-25" -c:v copy output.mp4
- Resize: ffmpeg -y -i input.mp4 -vf "scale=1280:720" output.mp4

CRITICAL RULES for generating commands:
1. ALWAYS prefer simple -vf or -af flags over filter_complex. Only use filter_complex when you truly need multiple inputs or complex branching.
2. When you DO use filter_complex with a split or asplit filter, ALWAYS specify the output count: write split=3[a][b][c] NOT split[a][b][c]. The default is 2 — if you omit the count with 3+ labels, FFmpeg will error.
3. Never generate -vf AND a separate -filter_complex in the same command.
4. Use simple filter chains (comma-separated) for single-input effects: -vf "filter1,filter2,filter3"
5. Always use -y flag to overwrite output. Provide safe, valid FFmpeg commands.
6. For time-range effects (e.g. user says "[0:14-0:34] Add pan"): ALWAYS add -ss START_SECONDS -to END_SECONDS before -i input.mp4 (e.g. "ffmpeg -y -ss 14 -to 34 -i input.mp4 -vf ..."). The server automatically converts this to a proper segment concat that preserves the full video. NEVER apply heavy motion filters to the full video when the user specifies a time range.
7. NEVER use enable='between(t,...)' — most motion filters reject it with "Not yet implemented".
8. For zoompan, ALWAYS use d=1. Never use d=N where N > 1 — d=N generates N output frames per input frame, turning a 12-minute video into N×12 minutes of output.
9. NEVER use scale=LARGE:-1 before zoompan (e.g. scale=8000:-1). Processing at 8000px is ~17× slower than 1920px with no visible quality gain for 1080p output.
10. For zoom/pan effects, always use z≥1.6. z=1.2 is barely perceptible. Use z=1.8–2.0 for a clearly visible cinematic effect.`,
        responseMimeType: "application/json",
      },
    });

    const responseText = response.text || "{}";
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      result = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { command: "", explanation: "Failed to parse response" };
    }

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("AI edit error:", error);
    return c.json(
      {
        error: "Failed to process AI request",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default app;
