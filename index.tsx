/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
  Type,
} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

interface TranscriptionEntry {
  speaker: 'You' | 'Gemini';
  text: string;
  sources?: {uri: string; title: string}[];
}

type AvatarState = 'IDLE' | 'LISTENING' | 'SPEAKING';
type AnimationMode = 'default' | 'vortex' | 'calm';
type AvatarShape = 'sphere' | 'cube' | 'torus' | 'face';

// Define a mapping from color names to RGB values
const colorMap: {[key: string]: {r: number; g: number; b: number}} = {
  red: {r: 1.0, g: 0.2, b: 0.2},
  green: {r: 0.2, g: 1.0, b: 0.2},
  blue: {r: 0.3, g: 0.5, b: 1.0},
  yellow: {r: 1.0, g: 1.0, b: 0.0},
  purple: {r: 0.8, g: 0.2, b: 0.8},
  orange: {r: 1.0, g: 0.5, b: 0.0},
  white: {r: 1.0, g: 1.0, b: 1.0},
  pink: {r: 1.0, g: 0.5, b: 0.7},
  default: {r: 0.3, g: 0.5, b: 1.0},
};

const changeColorFunction: FunctionDeclaration = {
  name: 'change_color',
  description: "Changes the assistant's color.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      color: {
        type: Type.STRING,
        description:
          'The color to change to. For example: red, green, blue, etc.',
      },
    },
    required: ['color'],
  },
};

const changeAnimationModeFunction: FunctionDeclaration = {
  name: 'change_animation_mode',
  description: "Changes the assistant's visual animation style.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      mode: {
        type: Type.STRING,
        description:
          "The animation mode to switch to. Available modes are 'default', 'vortex', and 'calm'.",
      },
    },
    required: ['mode'],
  },
};

const changeVoiceFunction: FunctionDeclaration = {
  name: 'change_voice',
  description: "Changes the assistant's voice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      voice: {
        type: Type.STRING,
        description:
          "The voice to switch to. Available voices are 'Jarvis', 'Zephyr', 'Puck', 'Charon', and 'Kore'.",
      },
    },
    required: ['voice'],
  },
};

const changeShapeFunction: FunctionDeclaration = {
  name: 'change_shape',
  description: "Changes the assistant's visual shape.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      shape: {
        type: Type.STRING,
        description:
          "The shape to change to. Available shapes are 'sphere', 'cube', 'torus', and 'face'.",
      },
    },
    required: ['shape'],
  },
};

const setReminderFunction: FunctionDeclaration = {
  name: 'set_reminder',
  description: 'Sets a reminder for the user.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      duration: {
        type: Type.NUMBER,
        description: 'The time in seconds until the reminder fires.',
      },
      message: {
        type: Type.STRING,
        description: 'The message for the reminder.',
      },
    },
    required: ['duration', 'message'],
  },
};

const webSearchFunction: FunctionDeclaration = {
  name: 'web_search',
  description:
    'Searches the web for up-to-date information on a given topic, person, or event. Use this for news, recent events, or topics you lack knowledge about.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search query.',
      },
    },
    required: ['query'],
  },
};

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status =
    'Click the mic and say "Hello", or try "Turn into a cube"';
  @state() error = '';
  @state() currentInputTranscription = '';
  @state() currentOutputTranscription = '';
  @state() transcriptionHistory: TranscriptionEntry[] = [];
  @state() avatarState: AvatarState = 'IDLE';
  @state() selectedVoice = 'Jarvis';
  @state() sphereColor = colorMap['default'];
  @state() animationMode: AnimationMode = 'default';
  @state() avatarShape: AvatarShape = 'sphere';

  private readonly voices = ['Jarvis', 'Zephyr', 'Puck', 'Charon', 'Kore'];
  @state() private pendingVoiceChange: string | null = null;
  private reminderTimeout: number | undefined;
  @state() private groundingChunks: any[] = [];

  private client: GoogleGenAI;
  private session: Session;
  private sessionPromise: Promise<Session>;
  // FIX: Cast window to any to allow for webkitAudioContext in older browsers.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to any to allow for webkitAudioContext in older browsers.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private speakingTimeout: number | undefined;

  // Ambient audio
  private ambientNode: GainNode;
  private idleOscillator: OscillatorNode;
  private blipOscillator: OscillatorNode;
  private blipGain: GainNode;
  private blipInterval: number | undefined;

  static styles = css`
    :host {
      font-family: 'Google Sans', sans-serif;
      color: white;
    }

    .transcript-container {
      position: absolute;
      bottom: 18vh;
      left: 0;
      right: 0;
      z-index: 10;
      color: rgba(255, 255, 255, 0.8);
      display: flex;
      flex-direction: column-reverse;
      align-items: center;
      gap: 12px;
      padding: 0 20px;
      max-height: 25vh;
      overflow-y: auto;
      -webkit-mask-image: linear-gradient(
        to bottom,
        transparent 0%,
        black 10%
      );
      mask-image: linear-gradient(to bottom, transparent 0%, black 10%);
    }

    .transcript-entry {
      background: rgba(0, 0, 0, 0.3);
      padding: 10px 18px;
      border-radius: 18px;
      max-width: 600px;
      width: fit-content;
      margin: 0 auto;
      text-align: left;
      animation: fadeIn 0.5s ease-in-out;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .transcript-entry .speaker {
      font-weight: bold;
      margin-right: 8px;
      display: block;
      margin-bottom: 4px;
    }

    .transcript-entry.user .speaker {
      color: #8ab4f8;
    }

    .transcript-entry.gemini .speaker {
      color: #f88a8a;
    }

    .sources {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.2);
    }

    .sources-title {
      font-weight: bold;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.8);
      display: block;
      margin-bottom: 6px;
    }

    .sources-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .source-link {
      background: rgba(255, 255, 255, 0.1);
      color: #a3c9ff;
      text-decoration: none;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 12px;
      transition: background-color 0.2s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 250px;
      display: inline-block;
    }

    .source-link:hover {
      background: rgba(255, 255, 255, 0.2);
      text-decoration: underline;
    }

    #status-container {
      position: absolute;
      bottom: 14vh;
      left: 0;
      right: 0;
      text-align: center;
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 4vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background-color 0.2s ease-in-out;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      #resetButton {
        width: 50px;
        height: 50px;
      }
    }

    .voice-selector {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }

    .voice-selector label {
      font-size: 10px;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.6);
    }

    .voice-selector select {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 8px;
      padding: 8px 12px;
      font-family: 'Google Sans', sans-serif;
      cursor: pointer;
      transition: background-color 0.2s ease-in-out;
      -webkit-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='white' class='bi bi-chevron-down' viewBox='0 0 16 16'%3E%3Cpath fill-rule='evenodd' d='M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 32px;
    }

    .voice-selector select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .voice-selector select:not(:disabled):hover {
      background: rgba(255, 255, 255, 0.1);
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;

    // Ambient sound setup
    this.ambientNode = this.outputAudioContext.createGain();
    this.ambientNode.connect(this.outputAudioContext.destination);
    this.ambientNode.gain.setValueAtTime(
      0,
      this.outputAudioContext.currentTime,
    );

    // Idle hum
    const idleGain = this.outputAudioContext.createGain();
    idleGain.gain.setValueAtTime(0.02, this.outputAudioContext.currentTime); // Very subtle
    this.idleOscillator = this.outputAudioContext.createOscillator();
    this.idleOscillator.type = 'sine';
    this.idleOscillator.frequency.setValueAtTime(
      50,
      this.outputAudioContext.currentTime,
    );
    this.idleOscillator.connect(idleGain).connect(this.ambientNode);
    this.idleOscillator.start();

    // Idle blips
    this.blipGain = this.outputAudioContext.createGain();
    this.blipGain.gain.setValueAtTime(0, this.outputAudioContext.currentTime);
    this.blipOscillator = this.outputAudioContext.createOscillator();
    this.blipOscillator.type = 'triangle';
    this.blipOscillator.frequency.setValueAtTime(
      880,
      this.outputAudioContext.currentTime,
    );
    this.blipOscillator.connect(this.blipGain).connect(this.ambientNode);
    this.blipOscillator.start();
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);
    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';
    const getApiVoiceName = (voice: string) =>
      voice === 'Jarvis' ? 'Fenrir' : voice;

    try {
      this.sessionPromise = this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            // Do not show "Connection opened" to user
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'change_color') {
                  // FIX: Cast fc.args.color to string because the `args` object from a function call has values of type `unknown`.
                  const colorName = (fc.args.color as string).toLowerCase();
                  this.sphereColor = colorMap[colorName] || colorMap['default'];
                  this.updateStatus(`Color changed to ${colorName}`);
                  this.sessionPromise.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: {result: 'ok'},
                      },
                    });
                  });
                } else if (fc.name === 'change_animation_mode') {
                  const mode = (fc.args.mode as string).toLowerCase();
                  if (['default', 'vortex', 'calm'].includes(mode)) {
                    this.animationMode = mode as AnimationMode;
                    this.updateStatus(`Animation mode set to ${mode}`);
                  }
                  this.sessionPromise.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: {result: 'ok'},
                      },
                    });
                  });
                } else if (fc.name === 'change_voice') {
                  const voiceName = fc.args.voice as string;
                  const formattedVoiceName =
                    this.voices.find(
                      (v) => v.toLowerCase() === voiceName.toLowerCase(),
                    ) || '';

                  if (this.voices.includes(formattedVoiceName)) {
                    this.pendingVoiceChange = formattedVoiceName;
                    this.updateStatus(
                      `Changing voice to ${formattedVoiceName}...`,
                    );
                    this.sessionPromise.then((session) => {
                      session.sendToolResponse({
                        functionResponses: {
                          id: fc.id,
                          name: fc.name,
                          response: {result: 'ok'},
                        },
                      });
                    });
                  } else {
                    this.updateError(`Invalid voice name: ${voiceName}`);
                    this.sessionPromise.then((session) => {
                      session.sendToolResponse({
                        functionResponses: {
                          id: fc.id,
                          name: fc.name,
                          response: {
                            result: `error: invalid voice name '${voiceName}'`,
                          },
                        },
                      });
                    });
                  }
                } else if (fc.name === 'change_shape') {
                  const shape = (fc.args.shape as string).toLowerCase();
                  if (['sphere', 'cube', 'torus', 'face'].includes(shape)) {
                    this.avatarShape = shape as AvatarShape;
                    this.updateStatus(`Shape changed to ${shape}`);
                  }
                  this.sessionPromise.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: {result: 'ok'},
                      },
                    });
                  });
                } else if (fc.name === 'set_reminder') {
                  const duration = fc.args.duration as number;
                  const message = fc.args.message as string;

                  if (this.reminderTimeout) {
                    clearTimeout(this.reminderTimeout);
                  }

                  this.updateStatus(
                    `OK, I'll remind you in ${duration} seconds.`,
                  );
                  this.reminderTimeout = window.setTimeout(() => {
                    this.updateStatus(`Reminder: ${message}`);
                  }, duration * 1000);

                  this.sessionPromise.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: {result: 'ok'},
                      },
                    });
                  });
                } else if (fc.name === 'web_search') {
                  const query = fc.args.query as string;
                  this.updateStatus(`Searching for: ${query}`);

                  try {
                    const response = await this.client.models.generateContent({
                      model: 'gemini-2.5-flash',
                      contents: query,
                      config: {
                        tools: [{googleSearch: {}}],
                      },
                    });

                    const searchResult = response.text;
                    const groundingMetadata =
                      response.candidates?.[0]?.groundingMetadata;
                    if (groundingMetadata?.groundingChunks?.length > 0) {
                      // Store sources to be displayed with the final answer
                      this.groundingChunks = groundingMetadata.groundingChunks;
                    }

                    this.sessionPromise.then((session) => {
                      session.sendToolResponse({
                        functionResponses: {
                          id: fc.id,
                          name: fc.name,
                          // Send the search result back to the model
                          response: {result: searchResult},
                        },
                      });
                    });
                  } catch (e) {
                    console.error('Web search failed:', e);
                    this.updateError(`Search failed for "${query}"`);
                    // Inform the model that the tool call failed
                    this.sessionPromise.then((session) => {
                      session.sendToolResponse({
                        functionResponses: {
                          id: fc.id,
                          name: fc.name,
                          response: {error: `Search failed: ${e.message}`},
                        },
                      });
                    });
                  }
                }
              }
            }
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.avatarState = 'SPEAKING';
              if (this.speakingTimeout) {
                clearTimeout(this.speakingTimeout);
              }
              this.speakingTimeout = window.setTimeout(() => {
                if (!this.isRecording) {
                  this.avatarState = 'IDLE';
                }
              }, 1000);

              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              this.currentInputTranscription +=
                message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              this.currentOutputTranscription +=
                message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const newHistory: TranscriptionEntry[] = [];
              if (this.currentInputTranscription.trim()) {
                newHistory.push({
                  speaker: 'You',
                  text: this.currentInputTranscription,
                });
              }
              if (this.currentOutputTranscription.trim()) {
                const geminiEntry: TranscriptionEntry = {
                  speaker: 'Gemini',
                  text: this.currentOutputTranscription,
                };
                // Attach the stored sources from the web_search tool call
                if (this.groundingChunks.length > 0) {
                  geminiEntry.sources = this.groundingChunks
                    .map((chunk: any) => chunk.web)
                    .filter(Boolean);
                }
                newHistory.push(geminiEntry);
              }
              this.transcriptionHistory = newHistory;
              this.currentInputTranscription = '';
              this.currentOutputTranscription = '';
              this.groundingChunks = []; // Reset for the next turn

              if (this.pendingVoiceChange) {
                this.selectedVoice = this.pendingVoiceChange;
                this.pendingVoiceChange = null;

                const remainingPlaybackTime =
                  this.nextStartTime - this.outputAudioContext.currentTime;
                const delay = Math.max(0, remainingPlaybackTime * 1000) + 500;

                this.updateStatus(`Applying voice change...`);
                setTimeout(() => {
                  this.newConversation({autoStart: true});
                }, delay);
              }
            }

            // FIX: Removed redundant call to `requestUpdate`. Lit automatically
            // schedules an update when properties decorated with `@state` are
            // modified, so this call was unnecessary and caused a type error.

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Connection closed.');
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: getApiVoiceName(this.selectedVoice),
              },
            },
          },
          systemInstruction:
            'You are a helpful AI assistant named Jarvis. You have several abilities: change your color (`change_color`), your animation style (`change_animation_mode`: "vortex", "calm"), your shape (`change_shape`: "sphere" (default), "cube", "torus", "face"), and your voice (`change_voice`: "Jarvis", "Zephyr", "Puck", "Charon", "Kore"). You can also set reminders (`set_reminder`) and search the web for current information (`web_search`).',
          tools: [
            {
              functionDeclarations: [
                changeColorFunction,
                changeAnimationModeFunction,
                changeVoiceFunction,
                changeShapeFunction,
                setReminderFunction,
                webSearchFunction,
              ],
            },
          ],
        },
      });
      this.session = await this.sessionPromise;
    } catch (e) {
      console.error(e);
      this.updateError(e.message);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  private async startRecording() {
    if (this.speakingTimeout) {
      clearTimeout(this.speakingTimeout);
      this.speakingTimeout = undefined;
    }
    this.inputAudioContext.resume();
    this.updateStatus('Requesting microphone...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      this.updateStatus('Listening...');
      this.avatarState = 'LISTENING';

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;
        const pcmData = audioProcessingEvent.inputBuffer.getChannelData(0);
        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
    } catch (err) {
      this.updateError(`Error starting recording: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.mediaStream && !this.inputAudioContext) return;

    this.updateStatus(
      'Click the mic and say "Hello", or try "Turn into a cube"',
    );
    this.isRecording = false;

    if (this.avatarState === 'LISTENING') {
      this.avatarState = 'IDLE';
    }

    if (this.speakingTimeout) {
      clearTimeout(this.speakingTimeout);
      this.speakingTimeout = undefined;
    }

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private handleVoiceChange(e: Event) {
    const selectElement = e.target as HTMLSelectElement;
    this.selectedVoice = selectElement.value;
    this.newConversation();
  }

  private playBlip() {
    if (this.avatarState !== 'IDLE' || !this.blipGain) return;
    const now = this.outputAudioContext.currentTime;
    this.blipGain.gain.setValueAtTime(0, now);
    this.blipGain.gain.linearRampToValueAtTime(0.1, now + 0.05); // Attack
    this.blipGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5); // Decay
  }

  private async newConversation(options: {autoStart?: boolean} = {}) {
    const {autoStart = false} = options;

    this.stopRecording();
    if (this.sessionPromise) {
      try {
        const session = await this.sessionPromise;
        session.close();
      } catch (e) {
        console.warn('Error closing session, continuing reset.', e);
      }
    }
    if (this.reminderTimeout) {
      clearTimeout(this.reminderTimeout);
      this.reminderTimeout = undefined;
    }
    this.transcriptionHistory = [];
    this.currentInputTranscription = '';
    this.currentOutputTranscription = '';
    this.groundingChunks = [];
    this.avatarState = 'IDLE';
    this.sphereColor = colorMap['default'];
    this.animationMode = 'default';
    this.avatarShape = 'sphere';

    // Reset ambient sounds
    if (this.blipInterval) {
      clearInterval(this.blipInterval);
      this.blipInterval = undefined;
    }
    if (this.ambientNode) {
      this.ambientNode.gain.cancelScheduledValues(
        this.outputAudioContext.currentTime,
      );
      this.ambientNode.gain.setValueAtTime(
        0,
        this.outputAudioContext.currentTime,
      );
    }

    this.initSession();

    if (autoStart) {
      try {
        await this.sessionPromise;
        await this.startRecording();
      } catch (e) {
        this.updateError(`Auto-restart failed: ${e.message}`);
      }
    } else {
      this.updateStatus(
        'Conversation cleared. Click the mic and say "Hello", or try "Turn into a cube".',
      );
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('avatarState')) {
      const oldState = changedProperties.get('avatarState');
      if (this.avatarState === 'IDLE' && oldState !== 'IDLE') {
        // Fades in the ambient hum
        this.ambientNode?.gain.linearRampToValueAtTime(
          0.5,
          this.outputAudioContext.currentTime + 2,
        );
        // Start random blips
        this.blipInterval = window.setInterval(() => {
          this.playBlip();
        }, Math.random() * 5000 + 2000);
      } else if (this.avatarState !== 'IDLE' && oldState === 'IDLE') {
        // Fades out the ambient hum
        this.ambientNode?.gain.linearRampToValueAtTime(
          0,
          this.outputAudioContext.currentTime + 1,
        );
        // Stop blips
        if (this.blipInterval) {
          clearInterval(this.blipInterval);
          this.blipInterval = undefined;
        }
      }
    }
  }

  render() {
    return html`
      <gdm-live-audio-visuals-3d
        .inputNode=${this.inputNode}
        .outputNode=${this.outputNode}
        .avatarState=${this.avatarState}
        .color=${this.sphereColor}
        .animationMode=${this.animationMode}
        .avatarShape=${this.avatarShape}
        .selectedVoice=${this.selectedVoice}
      ></gdm-live-audio-visuals-3d>
      <div class="transcript-container">
        ${this.transcriptionHistory.map(
          (entry) => html`
            <div
              class="transcript-entry ${entry.speaker === 'You'
                ? 'user'
                : 'gemini'}"
            >
              <span class="speaker">${entry.speaker}:</span>
              <span class="text">${entry.text}</span>
              ${entry.sources && entry.sources.length > 0
                ? html`
                    <div class="sources">
                      <span class="sources-title">Sources:</span>
                      <div class="sources-list">
                        ${entry.sources.map(
                          (source: any) => html`
                            <a
                              href=${source.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="source-link"
                            >
                              ${source.title || new URL(source.uri).hostname}
                            </a>
                          `,
                        )}
                      </div>
                    </div>
                  `
                : ''}
            </div>
          `,
        )}
        ${this.currentInputTranscription
          ? html`<div class="transcript-entry user">
              <span class="speaker">You:</span>
              <span class="text">${this.currentInputTranscription}...</span>
            </div>`
          : ''}
        ${this.currentOutputTranscription
          ? html`<div class="transcript-entry gemini">
              <span class="speaker">Gemini:</span>
              <span class="text">${this.currentOutputTranscription}...</span>
            </div>`
          : ''}
      </div>
      <div id="status-container">${this.error || this.status}</div>
      <div class="controls">
        <div class="voice-selector">
          <label for="voice-select">Voice</label>
          <select
            id="voice-select"
            @change=${this.handleVoiceChange}
            .value=${this.selectedVoice}
            ?disabled=${this.isRecording}
          >
            ${this.voices.map(
              (voice) => html`<option value=${voice}>${voice}</option>`,
            )}
          </select>
        </div>
        <button
          @click=${this.toggleRecording}
          aria-label=${this.isRecording ? 'Stop recording' : 'Start recording'}
        >
          ${this.isRecording
            ? html`<svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              </svg>`
            : html`<svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"
                ></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="22"></line>
              </svg>`}
        </button>
        <button
          id="resetButton"
          @click=${() => this.newConversation()}
          aria-label="New conversation"
          ?disabled=${this.isRecording}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <path
              d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"
            />
            <path
              d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"
            />
          </svg>
        </button>
      </div>
    `;
  }
}