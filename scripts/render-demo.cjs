/**
 * Render HyperEdit Demo Video
 *
 * Usage: node scripts/render-demo.cjs
 *
 * This will render the HyperEdit promotional video using Remotion.
 * Output will be saved to: hyper/output/HyperEdit-Demo.mp4
 */

const { spawnSync } = require('child_process');
const { readFileSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

const PROJECT_ROOT = join(__dirname, '..');
const DEMO_JSON = join(PROJECT_ROOT, 'src/remotion/demos/HyperEditDemo.json');
const OUTPUT_DIR = join(PROJECT_ROOT, 'output');
const OUTPUT_FILE = join(OUTPUT_DIR, 'HyperEdit-Demo.mp4');
const PROPS_FILE = join(OUTPUT_DIR, 'demo-props.json');

async function main() {
  console.log('🎬 HyperEdit Demo Video Renderer\n');

  // Ensure output directory exists
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load and prepare scene data
  console.log('📄 Loading scene data...');
  const sceneData = JSON.parse(readFileSync(DEMO_JSON, 'utf-8'));

  // Write props file for Remotion
  writeFileSync(PROPS_FILE, JSON.stringify(sceneData, null, 2));
  console.log(`   Props written to: ${PROPS_FILE}`);

  // Calculate duration
  const totalFrames = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
  const durationSeconds = totalFrames / 30;
  console.log(`   Total duration: ${durationSeconds.toFixed(1)}s (${totalFrames} frames @ 30fps)\n`);

  // Render with Remotion - use relative paths to avoid Windows issues
  console.log('🎥 Rendering with Remotion...');
  console.log('   This may take a few minutes...\n');

  // Build command as a single string for Windows
  const cmd = `npx remotion render src/remotion/index.tsx DynamicAnimation output/HyperEdit-Demo.mp4 --props=output/demo-props.json --codec=h264 --crf=18`;

  console.log(`Running: ${cmd}\n`);

  const result = spawnSync(cmd, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status === 0) {
    console.log('\n✅ Demo video rendered successfully!');
    console.log(`📁 Output: ${OUTPUT_FILE}`);
  } else {
    console.error(`\n❌ Render failed with code ${result.status}`);
  }
}

main();
