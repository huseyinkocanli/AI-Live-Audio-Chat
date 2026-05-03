/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:organize-imports
// tslint:disable:ban-malformed-import-paths
// tslint:disable:no-new-decorators

import {LitElement, css, html} from 'lit';
// FIX: Import the `query` decorator to get a reference to the canvas element.
import {customElement, property, query} from 'lit/decorators.js';
import {Analyser} from './analyser';

import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
import {fs as backdropFS, vs as backdropVS} from './backdrop-shader';
import {fs as particleFS, vs as particleVS} from './sphere-shader';

type AvatarShape = 'sphere' | 'cube' | 'torus' | 'face';

/**
 * 3D live audio visual.
 */
@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private backdrop!: THREE.Mesh;
  private composer!: EffectComposer;
  private particles!: THREE.Points;
  private prevTime = 0;
  private rotation = new THREE.Vector3(0, 0, 0);
  private readonly particleCount = 20000;

  private _outputNode!: AudioNode;

  @property() avatarState: 'IDLE' | 'LISTENING' | 'SPEAKING' = 'IDLE';

  @property() animationMode: 'default' | 'vortex' | 'calm' = 'default';

  @property() avatarShape: AvatarShape = 'sphere';

  @property() selectedVoice: string = 'Jarvis';

  @property({type: Object})
  color = {r: 0.3, g: 0.5, b: 1.0};

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }

  get inputNode() {
    return this._inputNode;
  }

  // FIX: Use the @query decorator to get a reference to the canvas element. This
  // is the recommended Lit practice and resolves the type error with
  // `this.shadowRoot`.
  @query('canvas')
  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      image-rendering: pixelated;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
  }

  private init() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x100c14);

    const backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(10, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: {value: new THREE.Vector2(1, 1)},
          rand: {value: 0},
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    backdrop.material.side = THREE.BackSide;
    scene.add(backdrop);
    this.backdrop = backdrop;

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    camera.position.set(0, 0, 5);
    this.camera = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Particle System
    const positions = this.generateParticlePositions('sphere');
    const randoms = new Float32Array(this.particleCount);

    for (let i = 0; i < this.particleCount; i++) {
      randoms[i] = Math.random();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));

    const particleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        time: {value: 0},
        uInputLevel: {value: 0},
        uOutputLevel: {value: 0},
        uAvatarState: {value: 0}, // 0: IDLE, 1: LISTENING, 2: SPEAKING
        uAnimationMode: {value: 0}, // 0: default, 1: vortex, 2: calm
        uPointSize: {value: window.devicePixelRatio * 3},
        uBaseColor: {
          value: new THREE.Color(this.color.r, this.color.g, this.color.b),
        },
      },
      vertexShader: particleVS,
      fragmentShader: particleFS,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      transparent: true,
    });

    this.particles = new THREE.Points(geometry, particleMaterial);
    scene.add(this.particles);

    const renderPass = new RenderPass(scene, camera);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5,
      0.4,
      0.85,
    );

    const fxaaPass = new ShaderPass(FXAAShader);

    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(fxaaPass);

    this.composer = composer;

    function onWindowResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      const dPR = renderer.getPixelRatio();
      const w = window.innerWidth;
      const h = window.innerHeight;
      backdrop.material.uniforms.resolution.value.set(w * dPR, h * dPR);
      renderer.setSize(w, h);
      composer.setSize(w, h);
      fxaaPass.material.uniforms['resolution'].value.set(
        1 / (w * dPR),
        1 / (h * dPR),
      );
    }

    window.addEventListener('resize', onWindowResize);
    onWindowResize();

    this.animation();
  }

  // NOTE: In a real-world application, this data would likely come from
  // loading a 3D model file (e.g., .obj, .gltf). For this self-contained
  // demo, we generate a stylized point cloud using mathematical functions.
  private generateMaleFacePositions(): Float32Array {
    const positions = new Float32Array(this.particleCount * 3);
    const headWidth = 2.0;
    const headHeight = 2.5;
    const jawline = 0.8; // Sharper jawline
    let p = 0;

    // Head Outline (more angular)
    const headParticles = this.particleCount * 0.4;
    for (let i = 0; i < headParticles; i++, p++) {
      const angle = (i / headParticles) * Math.PI * 2;
      const z = Math.cos(angle) * 0.4;
      const yFactor = Math.sin(angle);
      const x = Math.cos(angle) * headWidth;
      const y = yFactor * headHeight;
      positions[p * 3] = x - Math.sign(x) * (1 - Math.abs(yFactor)) * jawline;
      positions[p * 3 + 1] = y;
      positions[p * 3 + 2] = z;
    }

    // Eyes (wider set)
    const eyeParticles = this.particleCount * 0.15;
    for (let i = 0; i < eyeParticles; i++, p++) {
      const side = i < eyeParticles / 2 ? -1 : 1;
      const angle = (i / (eyeParticles / 2)) * Math.PI * 2;
      positions[p * 3] = 0.8 * side + Math.cos(angle) * 0.4;
      positions[p * 3 + 1] = 0.5 + Math.sin(angle) * 0.15;
      positions[p * 3 + 2] = 0.5 + Math.sin(angle) * 0.2;
    }

    // Nose (stronger bridge)
    const noseParticles = this.particleCount * 0.1;
    for (let i = 0; i < noseParticles; i++, p++) {
      const y = (i / noseParticles) * -1.2;
      positions[p * 3] = 0;
      positions[p * 3 + 1] = y;
      positions[p * 3 + 2] = 0.5 + (1 + y) * 0.5;
    }

    // Mouth (wider)
    const mouthParticles = this.particleCount * 0.2;
    for (let i = 0; i < mouthParticles; i++, p++) {
      const angle = (i / mouthParticles) * Math.PI * 2;
      positions[p * 3] = Math.cos(angle) * 0.8;
      positions[p * 3 + 1] = -1.0 + Math.sin(angle) * 0.1;
      positions[p * 3 + 2] = 0.5;
    }

    // Fill remaining with random noise
    for (; p < this.particleCount; p++) {
      positions[p * 3] = (Math.random() - 0.5) * headWidth * 1.5;
      positions[p * 3 + 1] = (Math.random() - 0.5) * headHeight * 1.5;
      positions[p * 3 + 2] = (Math.random() - 0.5) * 1.5;
    }

    return positions;
  }

  private generateFemaleFacePositions(): Float32Array {
    const positions = new Float32Array(this.particleCount * 3);
    const headWidth = 1.8;
    const headHeight = 2.4;
    const jawline = 0.4; // Softer jawline
    let p = 0;

    // Head Outline (rounder)
    const headParticles = this.particleCount * 0.4;
    for (let i = 0; i < headParticles; i++, p++) {
      const angle = (i / headParticles) * Math.PI * 2;
      const z = Math.cos(angle) * 0.4;
      positions[p * 3] =
        Math.cos(angle) * (headWidth - jawline * (1 - Math.abs(Math.sin(angle))));
      positions[p * 3 + 1] = Math.sin(angle) * headHeight;
      positions[p * 3 + 2] = z;
    }

    // Eyes (slightly larger)
    const eyeParticles = this.particleCount * 0.15;
    for (let i = 0; i < eyeParticles; i++, p++) {
      const side = i < eyeParticles / 2 ? -1 : 1;
      const angle = (i / (eyeParticles / 2)) * Math.PI * 2;
      positions[p * 3] = 0.7 * side + Math.cos(angle) * 0.45;
      positions[p * 3 + 1] = 0.5 + Math.sin(angle) * 0.2;
      positions[p * 3 + 2] = 0.5 + Math.sin(angle) * 0.2;
    }

    // Nose (less prominent)
    const noseParticles = this.particleCount * 0.1;
    for (let i = 0; i < noseParticles; i++, p++) {
      const y = (i / noseParticles) * -1.0;
      positions[p * 3] = 0;
      positions[p * 3 + 1] = y;
      positions[p * 3 + 2] = 0.4 + (1 + y) * 0.3;
    }

    // Mouth (less wide)
    const mouthParticles = this.particleCount * 0.2;
    for (let i = 0; i < mouthParticles; i++, p++) {
      const angle = (i / mouthParticles) * Math.PI * 2;
      positions[p * 3] = Math.cos(angle) * 0.6;
      positions[p * 3 + 1] = -1.0 + Math.sin(angle) * 0.15;
      positions[p * 3 + 2] = 0.5;
    }

    // Fill remaining with random noise
    for (; p < this.particleCount; p++) {
      positions[p * 3] = (Math.random() - 0.5) * headWidth * 1.5;
      positions[p * 3 + 1] = (Math.random() - 0.5) * headHeight * 1.5;
      positions[p * 3 + 2] = (Math.random() - 0.5) * 1.5;
    }

    return positions;
  }

  private generateParticlePositions(shape: AvatarShape): Float32Array {
    const positions = new Float32Array(this.particleCount * 3);

    if (shape === 'sphere') {
      const radius = 2;
      for (let i = 0; i < this.particleCount; i++) {
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = radius * Math.cos(phi);
      }
    } else if (shape === 'cube') {
      const size = 3; // Cube side length
      const halfSize = size / 2;
      for (let i = 0; i < this.particleCount; i++) {
        const face = Math.floor(Math.random() * 6);
        const x = Math.random() * size - halfSize;
        const y = Math.random() * size - halfSize;

        switch (face) {
          case 0: // +X
            positions[i * 3] = halfSize;
            positions[i * 3 + 1] = x;
            positions[i * 3 + 2] = y;
            break;
          case 1: // -X
            positions[i * 3] = -halfSize;
            positions[i * 3 + 1] = x;
            positions[i * 3 + 2] = y;
            break;
          case 2: // +Y
            positions[i * 3] = x;
            positions[i * 3 + 1] = halfSize;
            positions[i * 3 + 2] = y;
            break;
          case 3: // -Y
            positions[i * 3] = x;
            positions[i * 3 + 1] = -halfSize;
            positions[i * 3 + 2] = y;
            break;
          case 4: // +Z
            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = halfSize;
            break;
          case 5: // -Z
            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = -halfSize;
            break;
        }
      }
    } else if (shape === 'torus') {
      const majorRadius = 1.8;
      const minorRadius = 0.7;
      for (let i = 0; i < this.particleCount; i++) {
        const u = Math.random() * 2 * Math.PI;
        const v = Math.random() * 2 * Math.PI;
        positions[i * 3] =
          (majorRadius + minorRadius * Math.cos(v)) * Math.cos(u);
        positions[i * 3 + 1] =
          (majorRadius + minorRadius * Math.cos(v)) * Math.sin(u);
        positions[i * 3 + 2] = minorRadius * Math.sin(v);
      }
    } else if (shape === 'face') {
      const femaleVoices = ['Kore', 'Zephyr'];
      if (femaleVoices.includes(this.selectedVoice)) {
        return this.generateFemaleFacePositions();
      } else {
        return this.generateMaleFacePositions();
      }
    }

    return positions;
  }

  private updateParticleGeometry() {
    if (!this.particles) return;

    const newPositions = this.generateParticlePositions(this.avatarShape);
    this.particles.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(newPositions, 3),
    );
    this.particles.geometry.attributes.position.needsUpdate = true;
  }

  private animation() {
    requestAnimationFrame(() => this.animation());

    this.inputAnalyser.update();
    this.outputAnalyser.update();

    const t = performance.now();
    const dt = (t - this.prevTime) / (1000 / 60);
    this.prevTime = t;
    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial;
    const particleMaterial = this.particles.material as THREE.ShaderMaterial;

    backdropMaterial.uniforms.rand.value = Math.random() * 10000;
    particleMaterial.uniforms.time.value = t * 0.0005;

    // Calculate average audio levels
    const inputLevel =
      this.inputAnalyser.data.reduce((a, b) => a + b, 0) /
      (this.inputAnalyser.data.length * 255);
    const outputLevel =
      this.outputAnalyser.data.reduce((a, b) => a + b, 0) /
      (this.outputAnalyser.data.length * 255);

    // Smoothly update uniforms
    particleMaterial.uniforms.uInputLevel.value +=
      (inputLevel - particleMaterial.uniforms.uInputLevel.value) * 0.1;
    particleMaterial.uniforms.uOutputLevel.value +=
      (outputLevel - particleMaterial.uniforms.uOutputLevel.value) * 0.1;

    // Smoothly transition color
    (particleMaterial.uniforms.uBaseColor.value as THREE.Color).lerp(
      new THREE.Color(this.color.r, this.color.g, this.color.b),
      0.05,
    );

    if (this.avatarState === 'IDLE') {
      particleMaterial.uniforms.uAvatarState.value = 0.0;
    } else if (this.avatarState === 'LISTENING') {
      particleMaterial.uniforms.uAvatarState.value = 1.0;
    } else if (this.avatarState === 'SPEAKING') {
      particleMaterial.uniforms.uAvatarState.value = 2.0;
    }

    if (this.animationMode === 'vortex') {
      particleMaterial.uniforms.uAnimationMode.value = 1.0;
    } else if (this.animationMode === 'calm') {
      particleMaterial.uniforms.uAnimationMode.value = 2.0;
    } else {
      particleMaterial.uniforms.uAnimationMode.value = 0.0;
    }

    const f = 0.0005;

    // Dampen rotation to create a smoother feel when state changes
    this.rotation.x *= 0.95;
    this.rotation.y *= 0.95;
    this.rotation.z *= 0.95;

    if (this.avatarState === 'IDLE') {
      this.rotation.y += dt * f * 0.1;
    } else if (this.avatarState === 'LISTENING') {
      this.rotation.z += (dt * f * 0.7 * this.inputAnalyser.data[1]) / 255;
      this.rotation.y += (dt * f * 0.3 * this.inputAnalyser.data[2]) / 255;
    } else if (this.avatarState === 'SPEAKING') {
      this.rotation.x += (dt * f * 0.5 * this.outputAnalyser.data[1]) / 255;
      this.rotation.y += (dt * f * 0.25 * this.outputAnalyser.data[2]) / 255;
    }

    const euler = new THREE.Euler(
      this.rotation.x,
      this.rotation.y,
      this.rotation.z,
    );
    const quaternion = new THREE.Quaternion().setFromEuler(euler);
    const vector = new THREE.Vector3(0, 0, 5);
    vector.applyQuaternion(quaternion);
    this.camera.position.copy(vector);
    this.camera.lookAt(new THREE.Vector3(0, 0, 0));

    this.composer.render();
  }

  protected firstUpdated() {
    // FIX: The canvas element is now obtained via the @query decorator, so
    // manual querying which was causing a type error is no longer needed.
    this.init();
  }

  protected updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('avatarShape')) {
      this.updateParticleGeometry();
    }
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}