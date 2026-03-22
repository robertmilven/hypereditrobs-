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
  Easing,
} from 'remotion';

// ─── Helpers ───

const rand = (seed: number): number => {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
};

// ─── Light Streaks (converging lines) ───

const LightStreaks: React.FC<{ color?: string; intensity?: number }> = ({
  color = '#a855f7',
  intensity = 1,
}) => {
  const frame = useCurrentFrame();
  const streaks = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * 360;
    const length = 600 + rand(i * 7) * 800;
    const width = 1 + rand(i * 3) * 2;
    const speed = 0.5 + rand(i * 11) * 1.5;
    const progress = interpolate(frame * speed, [0, 40], [0, 1], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
    const opacity = progress * (0.15 + rand(i * 13) * 0.25) * intensity;
    return (
      <div key={i} style={{
        position: 'absolute',
        left: '50%', top: '50%',
        width: length * progress, height: width,
        background: `linear-gradient(90deg, transparent, ${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}, transparent)`,
        transform: `rotate(${angle}deg)`,
        transformOrigin: '0% 50%',
      }} />
    );
  });
  return <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>{streaks}</div>;
};

// ─── Floating Orbs ───

const FloatingOrbs: React.FC<{ count?: number }> = ({ count = 6 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const cx = 400 + rand(i * 3) * 1120;
        const cy = 200 + rand(i * 7) * 680;
        const size = 80 + rand(i * 11) * 200;
        const speed = 0.01 + rand(i * 13) * 0.02;
        const x = cx + Math.sin(frame * speed + i) * 60;
        const y = cy + Math.cos(frame * speed * 1.3 + i) * 40;
        const hue = (frame * 0.5 + i * 60) % 360;
        const opacity = 0.06 + rand(i * 17) * 0.08;
        return (
          <div key={i} style={{
            position: 'absolute', left: x - size / 2, top: y - size / 2,
            width: size, height: size, borderRadius: '50%',
            background: `radial-gradient(circle, hsla(${hue}, 80%, 60%, ${opacity}) 0%, transparent 70%)`,
            filter: `blur(${30 + rand(i * 19) * 40}px)`,
          }} />
        );
      })}
    </div>
  );
};

// ─── Particle Field ───

const ParticleField: React.FC<{ count?: number; color?: string }> = ({ count = 60, color }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const x = rand(i * 3) * 1920;
        const startY = rand(i * 7) * 1200;
        const speed = 0.5 + rand(i * 11) * 2;
        const size = 1 + rand(i * 13) * 3;
        const y = (startY - frame * speed * 1.5) % 1300;
        const opacity = 0.15 + rand(i * 17) * 0.4;
        const c = color || `hsl(${(260 + rand(i * 19) * 60) % 360}, 80%, 65%)`;
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: y < 0 ? y + 1300 : y,
            width: size, height: size, borderRadius: '50%',
            background: c, opacity,
            boxShadow: `0 0 ${size * 3}px ${c}`,
          }} />
        );
      })}
    </div>
  );
};

// ─── Code Rain (matrix style, subtle) ───

const CodeRain: React.FC = () => {
  const frame = useCurrentFrame();
  const cols = 30;
  const chars = '01{}[]<>/=;:async await const fn AI ML GPU'.split('');
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', opacity: 0.06 }}>
      {Array.from({ length: cols }, (_, i) => {
        const x = (i / cols) * 1920;
        const speed = 1 + rand(i * 3) * 3;
        const offset = rand(i * 7) * 1000;
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: 0,
            fontFamily: 'monospace', fontSize: 14, color: '#a855f7',
            transform: `translateY(${((frame * speed + offset) % 1200) - 100}px)`,
            whiteSpace: 'pre', lineHeight: '18px',
          }}>
            {Array.from({ length: 8 }, (_, j) =>
              chars[Math.floor(rand(i * 31 + j * 17 + Math.floor(frame / 5)) * chars.length)]
            ).join('\n')}
          </div>
        );
      })}
    </div>
  );
};

// ─── Letter-by-letter animated title ───

const AnimatedTitle: React.FC<{
  text: string; color?: string; fontSize?: number; delay?: number; glow?: string;
}> = ({ text, color = '#fff', fontSize = 90, delay = 0, glow }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: 'flex', justifyContent: 'center', overflow: 'hidden' }}>
      {text.split('').map((char, i) => {
        const charFrame = Math.max(0, frame - delay - i * 2);
        const y = spring({ frame: charFrame, fps, config: { damping: 10, stiffness: 200, mass: 0.4 }, from: 80, to: 0 });
        const opacity = interpolate(charFrame, [0, 5], [0, 1], { extrapolateRight: 'clamp' });
        const scale = spring({ frame: charFrame, fps, config: { damping: 8, stiffness: 300 }, from: 1.5, to: 1 });
        return (
          <span key={i} style={{
            display: 'inline-block',
            fontSize, fontWeight: 900, color,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            transform: `translateY(${y}px) scale(${scale})`,
            opacity,
            textShadow: glow ? `0 0 30px ${glow}, 0 0 60px ${glow}66` : undefined,
            letterSpacing: -2,
            minWidth: char === ' ' ? '0.3em' : undefined,
          }}>
            {char}
          </span>
        );
      })}
    </div>
  );
};

// ─── Scene 1: Cinematic Opening (0-105 frames / 3.5s) ───
// "What if editing videos... took seconds, not hours."

const Scene1_CinematicOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Fade in from black
  const blackOverlay = interpolate(frame, [0, 30], [1, 0], { extrapolateRight: 'clamp' });

  // Question text
  const q1Opacity = interpolate(frame, [10, 25, 55, 65], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const q2Opacity = interpolate(frame, [40, 55, 85, 95], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // Breathing glow
  const breathe = Math.sin(frame * 0.06) * 0.5 + 0.5;

  return (
    <AbsoluteFill style={{ background: '#050510' }}>
      <FloatingOrbs count={8} />
      <ParticleField count={30} color="rgba(168,85,247,0.6)" />

      {/* Central glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 50% 50%, rgba(168,85,247,${breathe * 0.08}) 0%, transparent 50%)`,
      }} />

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 20,
      }}>
        <div style={{
          fontSize: 42, color: '#8888aa', fontFamily: 'system-ui',
          fontWeight: 300, fontStyle: 'italic', opacity: q1Opacity,
          letterSpacing: 2,
        }}>
          What if editing videos...
        </div>
        <div style={{
          fontSize: 52, color: '#fff', fontFamily: 'system-ui',
          fontWeight: 700, opacity: q2Opacity,
          textShadow: '0 0 40px rgba(168,85,247,0.5)',
        }}>
          took seconds, not hours?
        </div>
      </div>

      {/* Fade from black */}
      <div style={{
        position: 'absolute', inset: 0, background: '#000',
        opacity: blackOverlay, pointerEvents: 'none',
      }} />
    </AbsoluteFill>
  );
};

// ─── Scene 2: Logo Reveal (105-180 frames / 2.5s) ───
// "HyperEdit"

const Scene2_LogoReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const borderColor = `hsl(${(frame * 6 + 260) % 360}, 90%, 60%)`;

  // Light streaks converge then logo appears
  const streakIntensity = interpolate(frame, [0, 20, 30], [0, 1, 0.3], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  // Shockwave ring
  const ringProgress = interpolate(frame, [15, 50], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ringScale = interpolate(ringProgress, [0, 1], [0, 4]);
  const ringOpacity = interpolate(ringProgress, [0, 0.3, 1], [0, 0.6, 0]);

  // Subtitle
  const subScale = spring({ frame: Math.max(0, frame - 40), fps, config: { damping: 12 }, from: 0, to: 1 });

  return (
    <AbsoluteFill style={{ background: '#0a0a12' }}>
      <CodeRain />
      <FloatingOrbs count={5} />
      <LightStreaks color={borderColor} intensity={streakIntensity} />
      <ParticleField count={50} />

      {/* Shockwave ring */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        width: 200, height: 200,
        transform: `translate(-50%, -50%) scale(${ringScale})`,
        border: `2px solid ${borderColor}`,
        borderRadius: '50%', opacity: ringOpacity,
        boxShadow: `0 0 20px ${borderColor}44`,
      }} />

      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <AnimatedTitle text="HyperEdit" fontSize={110} delay={12} glow={borderColor} />
        <div style={{
          marginTop: 16, transform: `scale(${subScale})`,
          display: 'flex', gap: 16, alignItems: 'center',
        }}>
          <div style={{ width: 40, height: 2, background: borderColor, opacity: 0.6 }} />
          <div style={{
            fontSize: 22, color: borderColor, fontWeight: 600,
            fontFamily: 'system-ui', letterSpacing: 8, textTransform: 'uppercase',
          }}>
            AI Video Editor
          </div>
          <div style={{ width: 40, height: 2, background: borderColor, opacity: 0.6 }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ─── Scene 3: Feature Cascade (180-360 frames / 6s) ───
// Features fly in with trails, stagger fast

const Scene3_FeatureCascade: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const features = [
    { icon: '🎤', text: 'Auto Captions', sub: 'Word-level precision', color: '#22c55e' },
    { icon: '✂️', text: 'Scene Detection', sub: 'Automatic cuts', color: '#a855f7' },
    { icon: '📑', text: 'Smart Chapters', sub: 'AI-generated', color: '#06b6d4' },
    { icon: '🎬', text: 'B-Roll AI', sub: 'Perfect suggestions', color: '#f59e0b' },
    { icon: '🎭', text: 'GIF Library', sub: 'Thousands of GIFs', color: '#ec4899' },
    { icon: '✨', text: 'AI Animations', sub: 'Custom motion graphics', color: '#8b5cf6' },
  ];

  const cardDelay = 25; // frames between each card

  return (
    <AbsoluteFill style={{ background: '#08081a' }}>
      <FloatingOrbs count={4} />
      <ParticleField count={40} />

      {/* Feature cards - alternating left/right with trail effect */}
      {features.map((feat, i) => {
        const startFrame = i * cardDelay;
        const localFrame = frame - startFrame;
        if (localFrame < -10) return null;

        const isLeft = i % 2 === 0;
        const enterX = spring({
          frame: Math.max(0, localFrame),
          fps, config: { damping: 12, stiffness: 150, mass: 0.6 },
          from: isLeft ? -1200 : 1200, to: 0,
        });
        const enterOpacity = interpolate(localFrame, [0, 10], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });

        // Cards stack vertically with offset
        const yPos = 140 + i * 130;

        // Glow trail
        const trailOpacity = interpolate(localFrame, [0, 8, 20], [0, 0.4, 0], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });

        // Scale bounce on arrive
        const scale = spring({
          frame: Math.max(0, localFrame),
          fps, config: { damping: 8, stiffness: 200, mass: 0.4 },
          from: 1.15, to: 1,
        });

        return (
          <React.Fragment key={i}>
            {/* Motion trail */}
            <div style={{
              position: 'absolute',
              left: isLeft ? 0 : undefined,
              right: isLeft ? undefined : 0,
              top: yPos, height: 80,
              width: Math.abs(enterX) + 400,
              background: `linear-gradient(${isLeft ? '90deg' : '270deg'}, transparent, ${feat.color}${Math.round(trailOpacity * 80).toString(16).padStart(2, '0')})`,
              filter: 'blur(20px)',
              transform: isLeft ? undefined : 'translateX(0)',
            }} />

            {/* Card */}
            <div style={{
              position: 'absolute',
              left: isLeft ? 200 : undefined,
              right: isLeft ? undefined : 200,
              top: yPos,
              transform: `translateX(${enterX}px) scale(${scale})`,
              opacity: enterOpacity,
              display: 'flex', alignItems: 'center', gap: 20,
              background: `linear-gradient(135deg, ${feat.color}11, ${feat.color}08)`,
              border: `1px solid ${feat.color}44`,
              borderRadius: 16, padding: '16px 32px',
              backdropFilter: 'blur(10px)',
            }}>
              <div style={{
                fontSize: 52,
                filter: `drop-shadow(0 0 15px ${feat.color}66)`,
              }}>{feat.icon}</div>
              <div>
                <div style={{
                  fontSize: 32, fontWeight: 800, color: '#fff',
                  fontFamily: 'system-ui',
                }}>
                  {feat.text}
                </div>
                <div style={{
                  fontSize: 16, color: feat.color, fontFamily: 'system-ui',
                  fontWeight: 500, marginTop: 2, opacity: 0.8,
                }}>
                  {feat.sub}
                </div>
              </div>
              {/* Accent bar */}
              <div style={{
                position: 'absolute', [isLeft ? 'left' : 'right']: 0, top: 0, bottom: 0,
                width: 4, borderRadius: 4,
                background: feat.color,
                boxShadow: `0 0 15px ${feat.color}66`,
              }} />
            </div>
          </React.Fragment>
        );
      })}

      {/* "All powered by AI" text at bottom */}
      {(() => {
        const textFrame = Math.max(0, frame - 140);
        const opacity = interpolate(textFrame, [0, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const y = spring({ frame: textFrame, fps, config: { damping: 15 }, from: 30, to: 0 });
        return (
          <div style={{
            position: 'absolute', bottom: 60, left: 0, right: 0,
            display: 'flex', justifyContent: 'center',
            opacity, transform: `translateY(${y}px)`,
          }}>
            <div style={{
              fontSize: 28, color: '#aaa', fontFamily: 'system-ui', fontWeight: 300,
              letterSpacing: 6, textTransform: 'uppercase',
            }}>
              All Powered by <span style={{ color: '#a855f7', fontWeight: 700 }}>AI</span>
            </div>
          </div>
        );
      })()}
    </AbsoluteFill>
  );
};

// ─── Scene 4: Epic Finale (360-540 frames / 6s) ───

const Scene4_EpicFinale: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Particle explosion from center
  const explosionProgress = interpolate(frame, [0, 30], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const explosionParticles = Array.from({ length: 80 }, (_, i) => {
    const angle = (i / 80) * Math.PI * 2 + rand(i * 3) * 0.5;
    const dist = (100 + rand(i * 7) * 600) * explosionProgress;
    const x = 960 + Math.cos(angle) * dist;
    const y = 540 + Math.sin(angle) * dist;
    const size = 2 + rand(i * 11) * 4;
    const hue = (260 + rand(i * 13) * 100) % 360;
    const opacity = interpolate(explosionProgress, [0, 0.3, 1], [0, 0.8, 0]);
    return (
      <div key={i} style={{
        position: 'absolute', left: x, top: y,
        width: size, height: size, borderRadius: '50%',
        background: `hsl(${hue}, 80%, 65%)`,
        opacity,
        boxShadow: `0 0 ${size * 3}px hsl(${hue}, 80%, 65%)`,
      }} />
    );
  });

  // Logo
  const logoDelay = 15;
  const logoScale = spring({
    frame: Math.max(0, frame - logoDelay),
    fps, config: { damping: 8, stiffness: 150, mass: 0.6 },
    from: 0, to: 1,
  });

  // Rotating ring behind logo
  const ringAngle = frame * 0.6;
  const ringOpacity = interpolate(frame, [20, 40], [0, 0.3], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Tagline
  const tagOpacity = interpolate(frame, [50, 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const tagY = spring({ frame: Math.max(0, frame - 50), fps, config: { damping: 15 }, from: 20, to: 0 });

  // "The future of video editing"
  const futureOpacity = interpolate(frame, [90, 110], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Breathing glow
  const breathe = Math.sin(frame * 0.08) * 0.5 + 0.5;
  const accentColor = `hsl(${(frame * 3 + 260) % 360}, 85%, 60%)`;

  // Second shockwave
  const ring2Progress = interpolate(frame, [60, 100], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ring2Scale = interpolate(ring2Progress, [0, 1], [0, 3]);
  const ring2Opacity = interpolate(ring2Progress, [0, 0.2, 1], [0, 0.4, 0]);

  return (
    <AbsoluteFill style={{ background: '#050510' }}>
      <FloatingOrbs count={6} />

      {/* Central glow */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(circle at 50% 50%, rgba(168,85,247,${breathe * 0.12}) 0%, transparent 40%)`,
      }} />

      {/* Explosion particles */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {explosionParticles}
      </div>

      <ParticleField count={50} />

      {/* Rotating decorative ring */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        width: 500, height: 500,
        transform: `translate(-50%, -50%) rotate(${ringAngle}deg)`,
        border: `1px solid ${accentColor}`,
        borderRadius: '50%', opacity: ringOpacity,
      }}>
        {[0, 90, 180, 270].map((deg) => (
          <div key={deg} style={{
            position: 'absolute', top: -4, left: '50%',
            width: 8, height: 8, borderRadius: '50%',
            background: accentColor,
            boxShadow: `0 0 10px ${accentColor}`,
            transform: `rotate(${deg}deg) translateY(-250px) translateX(-4px)`,
            transformOrigin: '4px 254px',
          }} />
        ))}
      </div>

      {/* Second shockwave */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        width: 200, height: 200,
        transform: `translate(-50%, -50%) scale(${ring2Scale})`,
        border: `1px solid ${accentColor}`,
        borderRadius: '50%', opacity: ring2Opacity,
      }} />

      {/* Main content */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        {/* Logo */}
        <div style={{
          transform: `scale(${logoScale})`,
          fontSize: 120, fontWeight: 900, color: '#fff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          letterSpacing: -4,
          textShadow: `0 0 60px ${accentColor}, 0 0 120px ${accentColor}44`,
        }}>
          HyperEdit
        </div>

        {/* Tagline */}
        <div style={{
          marginTop: 20, opacity: tagOpacity,
          transform: `translateY(${tagY}px)`,
          display: 'flex', gap: 16, alignItems: 'center',
        }}>
          <div style={{ width: 60, height: 2, background: `linear-gradient(90deg, transparent, ${accentColor})` }} />
          <div style={{
            fontSize: 26, fontWeight: 600, color: '#ddd',
            fontFamily: 'system-ui', letterSpacing: 8, textTransform: 'uppercase',
          }}>
            Edit Smarter · Ship Faster
          </div>
          <div style={{ width: 60, height: 2, background: `linear-gradient(270deg, transparent, ${accentColor})` }} />
        </div>

        {/* Future text */}
        <div style={{
          marginTop: 40, opacity: futureOpacity,
          fontSize: 20, color: '#777', fontFamily: 'system-ui',
          fontWeight: 300, letterSpacing: 4,
        }}>
          The future of video editing
        </div>
      </div>
    </AbsoluteFill>
  );
};


// ─── Main Composition: 18 seconds (540 frames) ───

export const YouTubeIntroEpic: React.FC = () => {
  return (
    <AbsoluteFill>
      {/* Voiceover audio — loud and clear */}
      <Audio src={staticFile('voiceover-epic.mp3')} volume={4} />

      {/* Scene 1: Cinematic opening — 0-3.5s (frames 0-104) */}
      <Sequence from={0} durationInFrames={105}>
        <Scene1_CinematicOpen />
      </Sequence>

      {/* Scene 2: Logo reveal — 3.5-6s (frames 105-179) */}
      <Sequence from={105} durationInFrames={75}>
        <Scene2_LogoReveal />
      </Sequence>

      {/* Scene 3: Feature cascade — 6-12s (frames 180-359) */}
      <Sequence from={180} durationInFrames={180}>
        <Scene3_FeatureCascade />
      </Sequence>

      {/* Scene 4: Epic finale — 12-18s (frames 360-539) */}
      <Sequence from={360} durationInFrames={180}>
        <Scene4_EpicFinale />
      </Sequence>
    </AbsoluteFill>
  );
};
