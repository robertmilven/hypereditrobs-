import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
  Audio,
  staticFile,
} from 'remotion';

// ─── Helpers ───

const hsl = (frame: number, speed = 1): string => {
  return `hsl(${(frame * speed * 4) % 360}, 100%, 55%)`;
};

const rand = (seed: number): number => {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
};

// ─── Particles Layer ───

const Particles: React.FC<{ count?: number; color?: string }> = ({ count = 40, color }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const x = rand(i * 3) * 1920;
        const startY = rand(i * 7) * 1080;
        const speed = 1 + rand(i * 11) * 3;
        const size = 2 + rand(i * 13) * 4;
        const y = (startY - frame * speed * 2) % 1200;
        const opacity = 0.2 + rand(i * 17) * 0.5;
        const c = color || hsl(frame + i * 20);
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: y < 0 ? y + 1200 : y,
            width: size, height: size, borderRadius: '50%',
            background: c, opacity,
            boxShadow: `0 0 ${size * 2}px ${c}`,
          }} />
        );
      })}
    </div>
  );
};

// ─── Scene 1: Logo Slam (0-75 frames / 2.5s) ───

const Scene1_LogoSlam: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 8, stiffness: 180, mass: 0.6 }, from: 3, to: 1 });
  const opacity = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: 'clamp' });

  // Shake on impact
  const shakeX = frame < 15 ? Math.sin(frame * 2.5) * Math.max(0, 12 - frame) : 0;
  const shakeY = frame < 15 ? Math.cos(frame * 3.1) * Math.max(0, 8 - frame) : 0;

  const borderColor = hsl(frame, 2);

  // Subtitle fade
  const subOpacity = interpolate(frame, [25, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Radial glow pulse
  const glowPulse = Math.sin(frame * 0.12) * 0.15 + 0.25;

  return (
    <AbsoluteFill style={{ background: '#0a0a0a' }}>
      {/* Radial glow behind logo */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 50% 50%, ${borderColor}${Math.round(glowPulse * 255).toString(16).padStart(2, '0')} 0%, transparent 50%)`,
      }} />
      <Particles count={30} />
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        transform: `translate(${shakeX}px, ${shakeY}px)`,
      }}>
        <div style={{
          fontSize: 100, fontWeight: 900, color: '#fff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          transform: `scale(${scale})`,
          opacity,
          textShadow: `0 0 40px ${borderColor}, 0 0 80px ${borderColor}66, 0 0 120px ${borderColor}33`,
          letterSpacing: -4,
        }}>
          HyperEdit
        </div>
        <div style={{
          fontSize: 24, color: borderColor, fontWeight: 600,
          fontFamily: 'system-ui', letterSpacing: 8, textTransform: 'uppercase',
          marginTop: 12, opacity: subOpacity,
        }}>
          AI Video Editor
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Scene 2: Rapid Feature Cards (75-255 frames / 6s) ───

const Scene2_FeatureBlitz: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const features = [
    { icon: '🎤', text: 'Auto Captions', color: '#22c55e', bg: '#0f1f15' },
    { icon: '✂️', text: 'Scene Detection', color: '#a855f7', bg: '#1a0f2e' },
    { icon: '📑', text: 'Smart Chapters', color: '#06b6d4', bg: '#0f1a1f' },
    { icon: '🎬', text: 'B-Roll AI', color: '#f59e0b', bg: '#1f1a0f' },
    { icon: '🎭', text: 'GIF Library', color: '#ec4899', bg: '#1f0f1a' },
    { icon: '✨', text: 'AI Animations', color: '#8b5cf6', bg: '#150f2e' },
  ];

  const cardDuration = 30; // frames per card (1s each)

  return (
    <AbsoluteFill style={{ background: '#0a0a0a' }}>
      {features.map((feat, i) => {
        const cardStart = i * cardDuration;
        const localFrame = frame - cardStart;
        if (localFrame < -5 || localFrame > cardDuration + 5) return null;

        const enterScale = spring({
          frame: Math.max(0, localFrame),
          fps, config: { damping: 10, stiffness: 200, mass: 0.5 },
          from: 0, to: 1,
        });
        const exitOpacity = interpolate(localFrame, [cardDuration - 5, cardDuration], [1, 0], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });

        // Alternating positions
        const xOffset = i % 2 === 0 ? -200 : 200;
        const enterX = spring({
          frame: Math.max(0, localFrame),
          fps, config: { damping: 12, stiffness: 180 },
          from: xOffset, to: 0,
        });

        return (
          <AbsoluteFill key={i} style={{
            background: `radial-gradient(circle at 50% 50%, ${feat.bg} 0%, #0a0a0a 70%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: exitOpacity,
          }}>
            <Particles count={15} color={feat.color} />
            <div style={{
              transform: `scale(${enterScale}) translateX(${enterX}px)`,
              display: 'flex', alignItems: 'center', gap: 30,
            }}>
              <div style={{
                fontSize: 100,
                filter: `drop-shadow(0 0 20px ${feat.color}66)`,
              }}>{feat.icon}</div>
              <div style={{
                fontSize: 64, fontWeight: 800, color: feat.color,
                fontFamily: 'system-ui, -apple-system, sans-serif',
                textShadow: `0 0 30px ${feat.color}44`,
              }}>{feat.text}</div>
            </div>
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};

// ─── Scene 3: Neon Showcase Frame (255-375 frames / 4s) ───

const Scene3_NeonFrame: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const floatY = Math.sin((frame / 30) * Math.PI * 2) * 6;
  const pulse = Math.sin((frame / 20) * Math.PI * 2);
  const glowSize = interpolate(pulse, [-1, 1], [15, 50]);

  const frameScale = spring({ frame, fps, config: { damping: 10, stiffness: 200 }, from: 0.5, to: 1 });

  // Equalizer bars
  const eqBars = Array.from({ length: 24 }, (_, i) => {
    const t = (frame + i * 4) * 0.2;
    return Math.min(60, Math.max(8, 10 + Math.abs(Math.sin(t) * 35 + Math.cos(t * 1.7) * 25)));
  });

  // Rotating ring
  const ringAngle = frame * 0.8;

  return (
    <AbsoluteFill style={{ background: '#0a0618', overflow: 'hidden' }}>
      {/* Grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)
        `,
        backgroundSize: '40px 40px',
      }} />

      <Particles count={25} color="#ff8c00" />

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        transform: `translateY(${floatY}px) scale(${frameScale})`,
      }}>
        {/* Rotating accent ring */}
        <div style={{
          position: 'absolute', width: 700, height: 700,
          border: '1px solid rgba(255,140,0,0.15)',
          borderRadius: '50%',
          transform: `rotate(${ringAngle}deg)`,
        }}>
          <div style={{
            position: 'absolute', top: -6, left: '50%',
            width: 12, height: 12, borderRadius: '50%',
            background: '#ff8c00', boxShadow: '0 0 15px #ff8c00',
          }} />
        </div>

        {/* Corner brackets */}
        <div style={{ position: 'relative' }}>
          {[
            { top: -16, left: -16, borderTop: '3px solid #00d4ff', borderLeft: '3px solid #00d4ff' },
            { top: -16, right: -16, borderTop: '3px solid #00d4ff', borderRight: '3px solid #00d4ff' },
            { bottom: -16, left: -16, borderBottom: '3px solid #00d4ff', borderLeft: '3px solid #00d4ff' },
            { bottom: -16, right: -16, borderBottom: '3px solid #00d4ff', borderRight: '3px solid #00d4ff' },
          ].map((s, i) => (
            <div key={i} style={{ position: 'absolute', width: 28, height: 28, ...s }} />
          ))}

          {/* Main frame */}
          <div style={{
            width: 860, height: 484,
            border: '3px solid #ff8c00',
            borderRadius: 8,
            background: 'linear-gradient(135deg, #111 0%, #1a1020 100%)',
            boxShadow: `0 0 ${glowSize}px #ff8c00, 0 0 ${glowSize * 2}px rgba(255,140,0,0.2)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 56, fontWeight: 900, color: '#fff',
                fontFamily: 'system-ui', letterSpacing: -2,
                textShadow: '0 0 30px rgba(255,140,0,0.5)',
              }}>
                Your Video Here
              </div>
              <div style={{
                fontSize: 20, color: '#888', marginTop: 8,
                fontFamily: 'monospace',
              }}>
                Drop in your screen recording
              </div>
            </div>
          </div>
        </div>

        {/* Equalizer */}
        <div style={{
          marginTop: 24, display: 'flex', alignItems: 'flex-end', gap: 4, height: 70,
        }}>
          {eqBars.map((h, i) => {
            const t = i / (eqBars.length - 1);
            return (
              <div key={i} style={{
                width: 4, height: h, borderRadius: 2,
                background: `linear-gradient(to top, #ff8c00, ${t > 0.5 ? '#00d4ff' : '#ff8c00'})`,
                boxShadow: `0 0 4px rgba(255,140,0,0.3)`,
              }} />
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Scene 4: CTA Finale (375-450 frames / 2.5s) ───

const Scene4_CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 8, stiffness: 200, mass: 0.5 }, from: 0, to: 1 });
  const borderColor = hsl(frame, 3);

  const taglineOpacity = interpolate(frame, [20, 35], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Pulse ring
  const ringScale = interpolate(frame, [0, 60], [0.5, 2], { extrapolateRight: 'clamp' });
  const ringOpacity = interpolate(frame, [0, 60], [0.5, 0], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#0a0a0a' }}>
      <Particles count={50} />

      {/* Pulse ring */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        width: 400, height: 400,
        transform: `translate(-50%, -50%) scale(${ringScale})`,
        border: `2px solid ${borderColor}`,
        borderRadius: '50%', opacity: ringOpacity,
      }} />

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          fontSize: 90, fontWeight: 900, color: '#fff',
          fontFamily: 'system-ui', letterSpacing: -3,
          transform: `scale(${logoScale})`,
          textShadow: `0 0 50px ${borderColor}, 0 0 100px ${borderColor}44`,
        }}>
          HyperEdit
        </div>
        <div style={{
          marginTop: 16, fontSize: 28, fontWeight: 600,
          color: '#ccc', fontFamily: 'system-ui',
          opacity: taglineOpacity, letterSpacing: 6,
          textTransform: 'uppercase',
        }}>
          Edit Smarter · Ship Faster
        </div>
      </div>
    </AbsoluteFill>
  );
};


// ─── Main Composition: ~15 seconds ───

export const YouTubeIntro: React.FC = () => {
  return (
    <AbsoluteFill>
      {/* Voiceover audio — boosted volume */}
      <Audio src={staticFile('voiceover.mp3')} volume={4} />

      {/* Scene 1: Logo Slam — 0-2.5s */}
      <Sequence from={0} durationInFrames={75}>
        <Scene1_LogoSlam />
      </Sequence>

      {/* Scene 2: Rapid Feature Cards — 2.5-8.5s */}
      <Sequence from={75} durationInFrames={180}>
        <Scene2_FeatureBlitz />
      </Sequence>

      {/* Scene 3: Neon Showcase — 8.5-12.5s */}
      <Sequence from={255} durationInFrames={120}>
        <Scene3_NeonFrame />
      </Sequence>

      {/* Scene 4: CTA Finale — 12.5-15s */}
      <Sequence from={375} durationInFrames={75}>
        <Scene4_CTA />
      </Sequence>
    </AbsoluteFill>
  );
};
