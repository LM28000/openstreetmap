/**
 * Couche personnalisée MapLibre (WebGL 2) qui dessine le vent en particules à traînée.
 *
 * Pourquoi une couche WebGL et non des couches deck.gl ? Des milliers de traînées qui changent
 * à chaque image obligeraient deck.gl à reconstruire (ou au moins à reverser) tous les sommets de
 * chemins à chaque image : plusieurs millisecondes de CPU. Ici le processeur ne fait que faire
 * avancer la tête de chaque particule (une lecture du champ de vent et trois additions) et
 * en envoie la position (12 octets par particule) ; la carte graphique dessine la traînée en
 * remontant le vent à rebours depuis la tête, dans le vertex shader. Elle s'adapte donc seule au
 * zoom, à l'inclinaison et au globe (le shader passe par `projectTile`, fourni par MapLibre).
 *
 * Choix de dessin :
 * - la vitesse affichée est une vitesse « à l'écran » (pixels par seconde) proportionnelle à celle du
 *   vent, quel que soit le zoom : sinon, le vent paraîtrait immobile de loin et fou de près ;
 * - un contour sombre translucide sous un cœur blanc, pour que les traînées se lisent sur la carte
 *   claire comme sous l'ombre de la nuit ;
 * - la vitesse du vent module l'opacité ; la traînée s'effile et s'estompe vers sa queue ;
 * - les particules naissent et meurent dans la zone visible, et sont d'autant plus nombreuses que
 *   la zone est grande à l'écran (densité constante).
 */
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { mercatorX, mercatorY, sampleMercator, type MercatorField } from './windField';

export const MAX_PARTICLES = 7000;
/** Une particule pour cette surface d'écran (pixels CSS carrés). */
const PIXELS_PER_PARTICLE = 220;
const LIFE_MIN_S = 1.8;
const LIFE_MAX_S = 4.4;
/** Segments d'une traînée, et temps de vol qu'elle représente. */
const TRAIL_SEGMENTS = 12;
const TRAIL_SECONDS = 1.1;
/** Vitesse à l'écran : pixels par seconde pour chaque m/s de vent. */
const PIXELS_PER_SECOND_PER_MS = 9;
/** Largeur du cœur et du contour (pixels CSS). */
const CORE_WIDTH = 2.2;
const HALO_WIDTH = 5;
/** Un pas plus grand qu'une demi-seconde (onglet en arrière-plan…) est ramené à celui-ci. */
const MAX_STEP_S = 0.05;
/** Couleur du contour : un bleu nuit, assez sombre pour le fond clair, translucide pour ne pas salir la nuit. */
const HALO_COLOR: [number, number, number, number] = [0.04, 0.08, 0.2, 0.62]; // un peu plus dense : le fond calme est plus clair que Liberty
const CORE_COLOR: [number, number, number, number] = [1, 1, 1, 1];

const VERTEX_SOURCE = (prelude: string, define: string) => `#version 300 es
${prelude}
${define}
#define SEGMENTS ${TRAIL_SEGMENTS}
layout(location = 0) in vec2 a_corner;   // x : rang du point dans la traînée (0 = tête), y : côté (-1 ou 1)
layout(location = 1) in vec3 a_particle; // position Mercator de la tête, âge relatif (0 à 1)
uniform sampler2D u_wind;                // (u, v) en m/s, rangées du nord au sud
uniform vec4 u_bbox;                     // x ouest, y nord, x est, y sud (Mercator)
uniform vec2 u_texSize;
uniform float u_step;                    // Mercator parcouru en un pas de traînée par m/s de vent
uniform vec2 u_viewport;                 // taille du tampon de dessin, en pixels
uniform float u_halfWidth;               // demi-largeur en pixels du tampon
uniform vec4 u_color;
out float v_alpha;
out float v_side;

vec3 windAt(vec2 p) {
  vec2 f = (p - u_bbox.xy) / (u_bbox.zw - u_bbox.xy);
  vec2 uv = (vec2(0.5) + clamp(f, 0.0, 1.0) * (u_texSize - 1.0)) / u_texSize;
  vec2 w = texture(u_wind, uv).rg;
  // Nord vers le haut : y Mercator croît vers le sud.
  return vec3(w.x, -w.y, length(w));
}

void main() {
  int s = int(a_corner.x + 0.5);
  vec2 p = a_particle.xy;
  vec3 w = windAt(p);
  float speed = w.z;
  float edge = 1.0;
  {
    vec2 f = (p - u_bbox.xy) / (u_bbox.zw - u_bbox.xy);
    edge = smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  }
  // Remonte le vent depuis la tête : chaque pas recule d'un segment.
  for (int i = 0; i < SEGMENTS; i++) {
    if (i >= s) break;
    p -= windAt(p).xy * u_step;
  }
  vec2 behind = p - windAt(p).xy * u_step;

  vec4 c0 = projectTile(p);
  vec4 c1 = projectTile(behind);
  vec2 d = (c0.xy / c0.w - c1.xy / c1.w) * u_viewport * 0.5; // direction en pixels
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  float along = float(s) / float(SEGMENTS);
  float taper = mix(1.0, 0.35, along);
  vec2 offset = normal * a_corner.y * u_halfWidth * taper / (u_viewport * 0.5);
  gl_Position = c0 + vec4(offset * c0.w, 0.0, 0.0);

  float life = a_particle.z;
  float lifeFade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.78, 1.0, life));
  // Même formule que \`opacityForSpeed\` (windField.ts).
  float t = clamp((speed - 1.0) / 16.0, 0.0, 1.0);
  float bySpeed = 0.55 + 0.45 * t * t * (3.0 - 2.0 * t);
  float tail = pow(1.0 - along, 1.3);
  v_alpha = bySpeed * tail * lifeFade * edge * u_color.a;
  v_side = a_corner.y;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform vec4 u_color;
in float v_alpha;
in float v_side;
out vec4 fragColor;
void main() {
  // Bord adouci : un cran d'anticrénelage sans passer par le multi-échantillonnage.
  float a = v_alpha * (1.0 - smoothstep(0.55, 1.0, abs(v_side)));
  fragColor = vec4(u_color.rgb * a, a); // alpha prémultiplié, comme l'attend MapLibre
}
`;

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const UNIFORM_NAMES = [
  'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane',
  'u_projection_transition', 'u_projection_fallback_matrix',
  'u_wind', 'u_bbox', 'u_texSize', 'u_step', 'u_viewport', 'u_halfWidth', 'u_color',
] as const;

/** Mesures de coût par image, en millisecondes de processeur (pour les contrôles de performance). */
export interface WindLayerStats {
  frames: number;
  /** Coût moyen sur les dernières images, côté processeur (calcul des particules + envoi + appels de dessin). */
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  particles: number;
}

export class WindParticleLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MapLibreMap | undefined;
  private field: MercatorField | null = null;
  private fieldVersion = 0;
  private uploadedVersion = -1;
  private texture: WebGLTexture | null = null;
  private cornerBuffer: WebGLBuffer | null = null;
  private particleBuffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private readonly programs = new Map<string, Program>();
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly ages = new Float32Array(MAX_PARTICLES);
  private readonly lives = new Float32Array(MAX_PARTICLES);
  private active = 0;
  private lastFrameAt = 0;
  private readonly sample: [number, number] = [0, 0];
  private readonly costs = new Float32Array(240);
  private costIndex = 0;
  private costCount = 0;
  private frames = 0;
  private disposed = false;

  constructor(id: string) {
    this.id = id;
  }

  /** Remplace le champ de vent (ou le retire avec `null` : plus rien n'est dessiné). */
  setField(field: MercatorField | null): void {
    this.field = field;
    this.fieldVersion++;
    if (!field) this.active = 0;
    this.map?.triggerRepaint();
  }

  /** Les données du champ ont été modifiées sur place. */
  touchField(): void {
    this.fieldVersion++;
    this.map?.triggerRepaint();
  }

  stats(): WindLayerStats {
    const n = this.costCount;
    const sorted = Array.from(this.costs.subarray(0, n)).sort((a, b) => a - b);
    const mean = n ? sorted.reduce((sum, x) => sum + x, 0) / n : 0;
    return { frames: this.frames, meanMs: mean, p95Ms: sorted[Math.floor(n * 0.95)] ?? 0, maxMs: sorted[n - 1] ?? 0, particles: this.active };
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error('le vent demande WebGL 2');
    this.map = map;
    this.disposed = false;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Sommets d'une traînée : pour chaque point, deux côtés (bande de triangles).
    const corners = new Float32Array((TRAIL_SEGMENTS + 1) * 4);
    for (let s = 0; s <= TRAIL_SEGMENTS; s++) corners.set([s, -1, s, 1], s * 4);
    this.cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    this.particleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions.byteLength, gl.DYNAMIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.uploadedVersion = -1;
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) return;
    this.disposed = true;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.cornerBuffer);
    gl.deleteBuffer(this.particleBuffer);
    gl.deleteVertexArray(this.vao);
    for (const { program } of this.programs.values()) gl.deleteProgram(program);
    this.programs.clear();
    this.texture = this.cornerBuffer = this.particleBuffer = this.vao = null;
    this.map = undefined;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    const field = this.field;
    if (this.disposed || !map || !field || !(gl instanceof WebGL2RenderingContext)) return;
    const started = performance.now();

    const now = started / 1000;
    const dt = this.lastFrameAt > 0 ? Math.min(MAX_STEP_S, now - this.lastFrameAt) : 0;
    this.lastFrameAt = now;

    const zoom = map.getZoom();
    // Mercator parcouru par seconde pour chaque m/s de vent, d'après la vitesse voulue à l'écran.
    const mercatorPerSecond = PIXELS_PER_SECOND_PER_MS / (512 * 2 ** zoom);
    this.advance(map, field, dt, mercatorPerSecond, zoom);
    this.upload(gl, field);

    const program = this.programFor(gl, options);
    gl.useProgram(program.program);
    const projection = options.defaultProjectionData;
    const u = program.uniforms;
    gl.uniformMatrix4fv(u.u_projection_matrix!, false, projection.mainMatrix as Float32Array);
    gl.uniform4fv(u.u_projection_tile_mercator_coords!, projection.tileMercatorCoords);
    gl.uniform4fv(u.u_projection_clipping_plane!, projection.clippingPlane);
    gl.uniform1f(u.u_projection_transition!, projection.projectionTransition);
    gl.uniformMatrix4fv(u.u_projection_fallback_matrix!, false, projection.fallbackMatrix as Float32Array);
    gl.uniform4f(u.u_bbox!, field.x0, field.y0, field.x1, field.y1);
    gl.uniform2f(u.u_texSize!, field.width, field.height);
    gl.uniform1f(u.u_step!, (mercatorPerSecond * TRAIL_SECONDS) / TRAIL_SEGMENTS);
    gl.uniform2f(u.u_viewport!, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1i(u.u_wind!, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // Les particules sont posées à l'altitude 0, par-dessus tout (comme les couches deck.gl du projet).
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.colorMask(true, true, true, true);

    gl.bindVertexArray(this.vao);
    const pixelRatio = gl.drawingBufferWidth / Math.max(1, map.getCanvas().clientWidth);
    if (this.active > 0) {
      for (const [color, width] of [[HALO_COLOR, HALO_WIDTH], [CORE_COLOR, CORE_WIDTH]] as const) {
        gl.uniform4fv(u.u_color!, color);
        gl.uniform1f(u.u_halfWidth!, (width / 2) * pixelRatio);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (TRAIL_SEGMENTS + 1) * 2, this.active);
      }
    }
    gl.bindVertexArray(null);

    // Coût côté processeur de cette image (les appels de dessin partent ensuite vers la carte graphique).
    this.costs[this.costIndex] = performance.now() - started;
    this.costIndex = (this.costIndex + 1) % this.costs.length;
    this.costCount = Math.min(this.costs.length, this.costCount + 1);
    this.frames++;
    map.triggerRepaint(); // animation continue
  }

  // --- Particules (processeur) ---

  /** Fait avancer toutes les particules, et fait renaître celles qui sont mortes ou sorties de la zone. */
  private advance(map: MapLibreMap, field: MercatorField, dt: number, mercatorPerSecond: number, zoom: number): void {
    // Zone visible, limitée à la zone couverte par le champ.
    const bounds = map.getBounds();
    const x0 = Math.max(field.x0, mercatorX(bounds.getWest()));
    const x1 = Math.min(field.x1, mercatorX(bounds.getEast()));
    const y0 = Math.max(field.y0, mercatorY(Math.min(85, bounds.getNorth())));
    const y1 = Math.min(field.y1, mercatorY(Math.max(-85, bounds.getSouth())));
    if (!(x1 > x0 && y1 > y0)) {
      this.active = 0;
      return;
    }
    // Densité constante à l'écran : le nombre de particules suit la surface visible (en pixels).
    const worldPixels = 512 * 2 ** zoom;
    const areaPixels = (x1 - x0) * worldPixels * (y1 - y0) * worldPixels;
    const target = Math.min(MAX_PARTICLES, Math.round(areaPixels / PIXELS_PER_PARTICLE));
    // Les nouvelles particules naissent vieillies au hasard : pas de vague de naissances simultanées.
    for (let i = this.active; i < target; i++) this.spawn(i, x0, x1, y0, y1, true);
    this.active = target;

    const sample = this.sample;
    const margin = 0.02 * Math.max(x1 - x0, y1 - y0);
    const step = dt * mercatorPerSecond;
    const { positions, ages, lives } = this;
    for (let i = 0; i < target; i++) {
      let x = positions[i * 3]!;
      let y = positions[i * 3 + 1]!;
      ages[i]! += dt;
      const outside = x < x0 - margin || x > x1 + margin || y < y0 - margin || y > y1 + margin;
      if (ages[i]! >= lives[i]! || outside || !sampleMercator(field, x, y, sample)) {
        this.spawn(i, x0, x1, y0, y1, false);
        continue;
      }
      x += sample[0] * step;
      y -= sample[1] * step; // y Mercator croît vers le sud
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = ages[i]! / lives[i]!;
    }
  }

  private spawn(i: number, x0: number, x1: number, y0: number, y1: number, randomAge: boolean): void {
    const life = LIFE_MIN_S + Math.random() * (LIFE_MAX_S - LIFE_MIN_S);
    const age = randomAge ? Math.random() * life : 0;
    this.positions[i * 3] = x0 + Math.random() * (x1 - x0);
    this.positions[i * 3 + 1] = y0 + Math.random() * (y1 - y0);
    this.positions[i * 3 + 2] = age / life;
    this.ages[i] = age;
    this.lives[i] = life;
  }

  // --- Envoi à la carte graphique ---

  private upload(gl: WebGL2RenderingContext, field: MercatorField): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positions, 0, this.active * 3);
    if (this.uploadedVersion === this.fieldVersion) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Demi-précision, filtrable partout en WebGL 2 (contrairement aux flottants 32 bits).
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, field.width, field.height, 0, gl.RG, gl.FLOAT, field.data);
    this.uploadedVersion = this.fieldVersion;
  }

  private programFor(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): Program {
    const { variantName, vertexShaderPrelude, define } = options.shaderData;
    const known = this.programs.get(variantName);
    if (known) return known;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader du vent : ${gl.getShaderInfoLog(shader) ?? ''}`);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SOURCE(vertexShaderPrelude, define)));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`programme du vent : ${gl.getProgramInfoLog(program) ?? ''}`);
    const uniforms: Program['uniforms'] = {};
    for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name);
    const created = { program, uniforms };
    this.programs.set(variantName, created);
    return created;
  }
}
