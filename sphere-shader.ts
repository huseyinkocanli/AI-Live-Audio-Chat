/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
const vs = `
uniform float time;
uniform float uInputLevel;
uniform float uOutputLevel;
uniform float uAvatarState; // 0: IDLE, 1: LISTENING, 2: SPEAKING
uniform float uAnimationMode; // 0: default, 1: vortex, 2: calm
uniform float uPointSize;
uniform vec3 uBaseColor;

attribute float aRandom;

varying float vRandom;
varying vec3 vColor;

// 3D Simplex noise
// https://github.com/stegu/webgl-noise/blob/master/src/noise3D.glsl

vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
  return mod289(((x*34.0)+1.0)*x);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  // First corner
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 =   v - i + dot(i, C.xxx) ;

  // Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  //   x0 = x0 - 0.0 + 0.0 * C.xxx;
  //   x1 = x0 - i1  + 1.0 * C.xxx;
  //   x2 = x0 - i2  + 2.0 * C.xxx;
  //   x3 = x0 - 1.0 + 3.0 * C.xxx;
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy; // 2.0*C.x = 1/3 = C.y
  vec3 x3 = x0 - D.yyy;      // -1.0+3.0*C.x = -1.0+0.5 = -0.5 = -D.y

  // Permutations
  i = mod289(i);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

  // Gradients: 7x7 points over a square, mapped onto an octahedron.
  // The ring size 17*17 = 289 is close to a multiple of 49 (49*6 = 294)
  float n_ = 0.142857142857; // 1.0/7.0
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);  //  mod(p,7*7)

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );    // mod(j,N)

  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  //vec4 s0 = vec4(lessThan(b0,0.0))*2.0 - 1.0;
  //vec4 s1 = vec4(lessThan(b1,0.0))*2.0 - 1.0;
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

  //Normalise gradients
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  // Mix final noise value
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                dot(p2,x2), dot(p3,x3) ) );
}

// Rotation matrix for vortex
mat3 rotationY(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat3(
        c, 0.0, -s,
        0.0, 1.0, 0.0,
        s, 0.0, c
    );
}

void main() {
  vRandom = aRandom;
  vec3 pos = position;
  vec3 npos = normalize(pos);

  float noiseTime = time * 0.5;
  float noiseStrength = 0.1;

  // Calm mode modifications
  if (uAnimationMode > 1.5) { // 2.0 = calm
    noiseTime *= 0.3;
    noiseStrength *= 0.5;
  }

  float noise = snoise(npos * 3.0 + noiseTime);

  // Base idle position
  vec3 idlePos = pos * (1.0 + noise * noiseStrength + sin(aRandom * 3.14 + time) * 0.05);

  // Vortex mode modification
  if (uAnimationMode > 0.5 && uAnimationMode < 1.5) { // 1.0 = vortex
      float vortexStrength = 2.0 + sin(time) * 0.5;
      mat3 rot = rotationY(time * 0.5 + pos.y * vortexStrength);
      idlePos = rot * idlePos;
  }

  float listeningDisplacement = uInputLevel * 1.5 * (1.0 - aRandom * 0.5);
  vec3 listeningPos = pos * (1.0 - listeningDisplacement) + npos * noise * 0.2;

  float speakingDisplacement = uOutputLevel * 3.0 * (1.0 - aRandom);
  vec3 speakingPos = pos * (1.0 + speakingDisplacement) + npos * noise * 0.4;

  vec3 finalPos;
  if (uAvatarState < 0.5) { // IDLE
    finalPos = idlePos;
    vColor = uBaseColor;
  } else if (uAvatarState < 1.5) { // LISTENING
    finalPos = listeningPos;
    vColor = mix(uBaseColor, vec3(0.4, 1.0, 0.8), uInputLevel * 5.0);
  } else { // SPEAKING
    finalPos = speakingPos;
    vColor = mix(uBaseColor, vec3(1.0, 0.4, 0.6), uOutputLevel * 4.0);
  }

  vec4 modelPosition = modelMatrix * vec4(finalPos, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  vec4 projectedPosition = projectionMatrix * viewPosition;

  gl_Position = projectedPosition;

  float size = uPointSize;
  if (uAvatarState > 1.5) { // SPEAKING
    size *= (1.0 + uOutputLevel * 3.0);
  } else if (uAvatarState > 0.5) { // LISTENING
    size *= (1.0 + uInputLevel * 1.5);
  }
  gl_PointSize = size;
}
`;

const fs = `
varying float vRandom;
varying vec3 vColor;

void main() {
  float dist = length(gl_PointCoord - vec2(0.5));
  float opacity = 1.0 - smoothstep(0.4, 0.5, dist);
  opacity *= (0.5 + vRandom * 0.5);

  gl_FragColor = vec4(vColor, opacity);
}
`;

export {fs, vs};
