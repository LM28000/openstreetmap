/**
 * Couche WebGL « rideau » des photos aériennes : elle dessine les tuiles de l'IGN (WMTS) elle-même,
 * drapées sur le relief de MapLibre, et ne garde que les pixels à gauche du rideau.
 *
 * Pourquoi une couche « custom » plutôt qu'une couche raster MapLibre ?
 * - MapLibre ne sait pas découper une couche à l'écran. De plus, avec le relief 3D, ses couches
 *   raster sont dessinées dans des textures par tuile (« render to texture »), puis plaquées sur
 *   le terrain : un test de ciseau (scissor) ou un masque écran n'y a aucun effet.
 * - Une couche custom est dessinée dans la passe principale, après le terrain : on y connaît
 *   `gl_FragCoord`, donc le rideau est un simple `discard` dans le shader (coût : une comparaison
 *   par pixel). Le drapé est fait à la main : chaque tuile est un maillage de 8 × 8 cases dont
 *   les sommets prennent l'altitude affichée du relief (`map.queryTerrainElevation`, exagération
 *   comprise), puis le test de profondeur avec le terrain de MapLibre masque ce qui est derrière
 *   une crête.
 * - La seconde solution envisagée, une deuxième carte synchronisée et découpée en CSS, coûte un
 *   second rendu complet du relief et cache les noms de lieux et les couches deck.gl du côté
 *   « photo » : ici, tout reste dessiné par-dessus (la couche s'intercale sous les étiquettes).
 *
 * Le même code sert au mode « Transparence » : pas de rideau (`curtain = Infinity`), opacité réglable.
 */
import type { CustomLayerInterface, Map as MapLibreMap, OverscaledTileID } from 'maplibre-gl';

/** Taille d'une tuile en unités de tuile de MapLibre (`EXTENT`). */
const EXTENT = 8192;
/** Cases par côté du maillage d'une tuile. */
const GRID = 8;
/** Circonférence de la Terre (m) à l'équateur, pour passer des mètres aux pixels du monde. */
const EARTH_CIRCUMFERENCE = 40_075_016.686;
/** Au plus ce nombre de tuiles en mémoire (textures de 256 × 256 × 4 octets, soit 256 Ko pièce). */
const MAX_TILES = 220;
/** Requêtes de tuiles en même temps. */
const MAX_PARALLEL = 8;
/** Textures envoyées à la carte graphique par image, et maillages recalculés par image. */
const UPLOADS_PER_FRAME = 4;
const MESH_BUILDS_PER_FRAME = 2;
/** On remonte au plus de 6 niveaux pour trouver une tuile « parente » à afficher en attendant la bonne. */
const MAX_FALLBACK_LEVELS = 6;

/** Une « époque » de photos : une couche du service WMTS de l'IGN. */
export interface Vintage {
  /** Nom de la couche dans le service WMTS. */
  layer: string;
  style: string;
  format: 'image/png' | 'image/jpeg';
  minZoom: number;
  maxZoom: number;
}

export function tileUrl(vintage: Vintage, z: number, x: number, y: number): string {
  return (
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${vintage.layer}&STYLE=${vintage.style}&FORMAT=${vintage.format}&TILEMATRIXSET=PM` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`
  );
}

const VERTEX = `#version 300 es
in vec3 a_pos;              // x, y en unités de tuile (0..8192), z = altitude en mètres
uniform mat4 u_matrix;      // tuile -> écran, fournie par MapLibre pour cette tuile
uniform float u_zScale;     // mètres -> pixels du monde, pour la latitude de la tuile
uniform vec3 u_uv;          // décalage x, y et échelle de la zone de texture (tuile parente)
out vec2 v_uv;
void main() {
  v_uv = u_uv.xy + (a_pos.xy / ${EXTENT}.0) * u_uv.z;
  gl_Position = u_matrix * vec4(a_pos.xy, a_pos.z * u_zScale, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_curtain;    // abscisse du rideau en pixels de l'écran ; tout ce qui est à droite est jeté
uniform float u_opacity;
out vec4 outColor;
void main() {
  if (gl_FragCoord.x > u_curtain) discard;
  outColor = texture(u_tex, v_uv) * u_opacity;   // texture pré-multipliée : le noir « transparent » du service reste transparent
}`;

interface Mesh {
  buffer: WebGLBuffer;
  /** Le relief était-il chargé pour tous les sommets ? Sinon on recalcule quand il arrive. */
  complete: boolean;
  builtAtTerrain: number;
  zoomBucket: number;
}

interface TileEntry {
  key: string;
  z: number;
  x: number;
  y: number;
  state: 'waiting' | 'loading' | 'decoded' | 'ready' | 'failed';
  bitmap?: ImageBitmap;
  texture?: WebGLTexture;
  mesh?: Mesh;
  lastUsed: number;
  abort?: AbortController;
}

export interface CurtainLayer extends CustomLayerInterface {
  /** Réglages courants, modifiables à chaud. */
  setVintage(vintage: Vintage): void;
  /** Abscisse du rideau en pixels CSS (`Infinity` : pas de rideau). */
  setCurtain(cssX: number): void;
  setOpacity(opacity: number): void;
  /** Couche prête (cartes, textures) : utile aux tests. */
  stats(): { tiles: number; ready: number; renderMs: number; frames: number; buildMs: number; builds: number; drawn: number; coveringMs: number };
}

/** Longitude et latitude du coin (x, y) d'une tuile, fractions `u`, `v` en plus. */
function tileLngLat(z: number, x: number, y: number, u: number, v: number): [number, number] {
  const n = 2 ** z;
  const lon = ((x + u) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + v)) / n))) * 180) / Math.PI;
  return [lon, lat];
}

export function createCurtainLayer(id: string, initial: Vintage): CurtainLayer {
  let map: MapLibreMap;
  let gl: WebGL2RenderingContext;
  let program: WebGLProgram;
  let indexBuffer: WebGLBuffer;
  let indexCount = 0;
  let uniforms: Record<'matrix' | 'zScale' | 'uv' | 'tex' | 'curtain' | 'opacity', WebGLUniformLocation | null>;
  let vao: WebGLVertexArrayObject;
  let positionLocation = 0;

  let vintage = initial;
  let curtainCss = Infinity;
  let opacity = 1;
  let frame = 0;
  let terrainVersion = 0;
  let inFlight = 0;
  let renderMs = 0;
  let buildMs = 0;
  let totalBuilds = 0;
  let drawn = 0;
  let coveringMs = 0;
  let frames = 0;
  const tiles = new Map<string, TileEntry>();
  /**
   * Altitudes déjà demandées à MapLibre (`queryTerrainElevation` coûte 0,14 ms l'appel : un maillage de
   * 81 sommets, 11 ms). Les tuiles voisines partagent leurs sommets de bord ; on mémorise donc
   * l'altitude par position, pour un palier de zoom donné (le relief s'affine quand on zoome).
   */
  const elevations = new Map<string, number>();
  let terrainTimer: ReturnType<typeof setTimeout> | undefined;

  const keyOf = (z: number, x: number, y: number) => `${vintage.layer}/${z}/${x}/${y}`;

  function compile(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader : ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }

  /** Le relief change (tuiles d'altitude reçues) : les maillages incomplets seront refaits. */
  const onTerrain = (event?: { sourceId?: string; tile?: unknown }) => {
    if (event && (event.sourceId !== 'relief' || !event.tile)) return;
    clearTimeout(terrainTimer);
    terrainTimer = setTimeout(() => {
      terrainVersion++;
      map.triggerRepaint();
    }, 150);
  };

  function buildMesh(tile: TileEntry): void {
    const { z, x, y } = tile;
    const hasTerrain = map.getTerrain() !== null;
    const bucket = Math.floor(map.getZoom());
    if (elevations.size > 40_000) elevations.clear();
    const side = GRID + 1;
    const data = new Float32Array(side * side * 3);
    let complete = true;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const o = (j * side + i) * 3;
        data[o] = (i / GRID) * EXTENT;
        data[o + 1] = (j / GRID) * EXTENT;
        let height = 0;
        if (hasTerrain) {
          const [lon, lat] = tileLngLat(z, x, y, i / GRID, j / GRID);
          const key = `${bucket}:${lon.toFixed(6)}:${lat.toFixed(6)}`;
          let elevation = elevations.get(key);
          if (elevation === undefined) {
            const asked = map.queryTerrainElevation([lon, lat]);
            if (asked == null) complete = false;
            else {
              elevation = asked;
              elevations.set(key, asked);
            }
          }
          height = elevation ?? 0;
        }
        data[o + 2] = height;
      }
    }
    const buffer = tile.mesh?.buffer ?? gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    tile.mesh = { buffer, complete: complete || !hasTerrain, builtAtTerrain: terrainVersion, zoomBucket: bucket };
  }

  function request(tile: TileEntry): void {
    tile.state = 'loading';
    inFlight++;
    const abort = new AbortController();
    tile.abort = abort;
    fetch(tileUrl(vintage, tile.z, tile.x, tile.y), { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' }))
      .then((bitmap) => {
        tile.bitmap = bitmap;
        tile.state = 'decoded';
        map.triggerRepaint();
      })
      .catch(() => {
        // Hors couverture (404) ou réseau : on ne réessaie pas à chaque image.
        if (tile.state === 'loading') tile.state = 'failed';
      })
      .finally(() => {
        inFlight--;
        tile.abort = undefined;
        map.triggerRepaint();
      });
  }

  function upload(tile: TileEntry): void {
    const bitmap = tile.bitmap;
    if (!bitmap) return;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); // déjà pré-multipliée par createImageBitmap
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    bitmap.close();
    tile.bitmap = undefined;
    tile.texture = texture;
    tile.state = 'ready';
  }

  function release(tile: TileEntry): void {
    tile.abort?.abort();
    tile.bitmap?.close();
    if (tile.texture) gl.deleteTexture(tile.texture);
    if (tile.mesh) gl.deleteBuffer(tile.mesh.buffer);
    tiles.delete(tile.key);
  }

  /** Tuile prête la plus proche en remontant l'arbre : en attendant la bonne, on montre une version floue. */
  function fallbackFor(tile: TileEntry): { entry: TileEntry; uv: [number, number, number] } | undefined {
    for (let level = 1; level <= MAX_FALLBACK_LEVELS && tile.z - level >= vintage.minZoom; level++) {
      const z = tile.z - level;
      const x = tile.x >> level;
      const y = tile.y >> level;
      const parent = tiles.get(keyOf(z, x, y));
      if (parent?.state === 'ready') {
        parent.lastUsed = frame;
        const size = 2 ** level;
        return { entry: parent, uv: [(tile.x - x * size) / size, (tile.y - y * size) / size, 1 / size] };
      }
    }
    return undefined;
  }

  function projection(id: OverscaledTileID) {
    const transform = map.transform as unknown as {
      getProjectionData(params: { overscaledTileID: OverscaledTileID }): { mainMatrix: ArrayLike<number> };
      worldSize: number;
    };
    return { matrix: transform.getProjectionData({ overscaledTileID: id }).mainMatrix, worldSize: transform.worldSize };
  }

  return {
    id,
    type: 'custom',
    renderingMode: '3d',

    onAdd(addedTo, context) {
      map = addedTo;
      gl = context as WebGL2RenderingContext;
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`programme : ${gl.getProgramInfoLog(program)}`);
      uniforms = {
        matrix: gl.getUniformLocation(program, 'u_matrix'),
        zScale: gl.getUniformLocation(program, 'u_zScale'),
        uv: gl.getUniformLocation(program, 'u_uv'),
        tex: gl.getUniformLocation(program, 'u_tex'),
        curtain: gl.getUniformLocation(program, 'u_curtain'),
        opacity: gl.getUniformLocation(program, 'u_opacity'),
      };
      positionLocation = gl.getAttribLocation(program, 'a_pos');
      // Indices communs à toutes les tuiles : deux triangles par case.
      const indices: number[] = [];
      const side = GRID + 1;
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const a = j * side + i;
          indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
        }
      }
      indexCount = indices.length;
      indexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
      vao = gl.createVertexArray()!;
      map.on('sourcedata', onTerrain);
      map.on('terrain', onTerrain);
    },

    onRemove() {
      map.off('sourcedata', onTerrain);
      map.off('terrain', onTerrain);
      clearTimeout(terrainTimer);
      for (const tile of [...tiles.values()]) release(tile);
      elevations.clear();
      gl.deleteProgram(program);
      gl.deleteBuffer(indexBuffer);
      gl.deleteVertexArray(vao);
    },

    render() {
      const started = performance.now();
      frame++;
      // Globe : la projection n'est pas celle d'un plan, le drapé n'a pas de sens ici (le résumé du module le dit).
      if (map.getProjection()?.type === 'globe') return;

      // 1. Quelles tuiles voit-on ? MapLibre sait déjà abaisser la résolution des tuiles lointaines quand la carte est inclinée.
      const tCover = performance.now();
      const covering = map.coveringTiles({ tileSize: 256, minzoom: vintage.minZoom, maxzoom: vintage.maxZoom, roundZoom: true });
      coveringMs += performance.now() - tCover;
      const wanted: Array<{ tile: TileEntry; id: OverscaledTileID }> = [];
      for (const id of covering) {
        const { z, x, y } = id.canonical;
        const key = keyOf(z, x, y);
        let tile = tiles.get(key);
        if (!tile) {
          tile = { key, z, x, y, state: 'waiting', lastUsed: frame };
          tiles.set(key, tile);
        }
        tile.lastUsed = frame;
        wanted.push({ tile, id });
      }

      // 2. Lancer les téléchargements (les plus proches de l'écran d'abord : l'ordre de MapLibre), en nombre limité.
      for (const { tile } of wanted) {
        if (inFlight >= MAX_PARALLEL) break;
        if (tile.state === 'waiting') request(tile);
      }
      let uploads = 0;
      for (const { tile } of wanted) {
        if (tile.state === 'decoded' && uploads < UPLOADS_PER_FRAME) {
          upload(tile);
          uploads++;
        }
      }
      // Les ancêtres déjà prêts servent de repli : on les garde vivants.
      let more = false;
      for (const { tile } of wanted) if (tile.state === 'decoded' || tile.state === 'waiting' || tile.state === 'loading') more = true;

      // 3. Maillages : refaits quand le relief change et qu'ils étaient incomplets (ou que le zoom a changé d'un niveau).
      let builds = 0;
      const bucket = Math.floor(map.getZoom());
      for (const { tile } of wanted) {
        const stale = !tile.mesh || (tile.mesh.builtAtTerrain !== terrainVersion && (!tile.mesh.complete || tile.mesh.zoomBucket !== bucket));
        if (stale && builds < MESH_BUILDS_PER_FRAME) {
          const t0 = performance.now();
          buildMesh(tile);
          buildMs += performance.now() - t0;
          builds++;
          totalBuilds++;
        } else if (stale) more = true;
      }

      // 4. Dessin.
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      // Un cran devant le terrain de MapLibre. Le maillage de la photo (8 × 8 cases par tuile) n'est pas celui du
      // terrain : sans ce décalage de profondeur, la photo disparaît là où le terrain la dépasse de quelques mètres
      // (valeur trouvée à l'essai : -2000 unités de profondeur suffisent, -2 ne montrent rien).
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -3000);
      const dpr = gl.drawingBufferWidth / (map.getCanvas().clientWidth || 1);
      gl.uniform1f(uniforms.curtain, Number.isFinite(curtainCss) ? curtainCss * dpr : 1e9);
      gl.uniform1f(uniforms.opacity, opacity);
      gl.uniform1i(uniforms.tex, 0);
      gl.activeTexture(gl.TEXTURE0);

      // L'ordre n'a pas d'importance : les tuiles ne se recouvrent pas.
      for (const { tile, id } of wanted) {
        const mesh = tile.mesh;
        if (!mesh) continue;
        let source = tile;
        let uv: [number, number, number] = [0, 0, 1];
        if (tile.state !== 'ready') {
          const fallback = fallbackFor(tile);
          if (!fallback) continue;
          source = fallback.entry;
          uv = fallback.uv;
        }
        const { matrix, worldSize } = projection(id);
        const [, lat] = tileLngLat(tile.z, tile.x, tile.y, 0.5, 0.5);
        gl.uniformMatrix4fv(uniforms.matrix, false, Float32Array.from(matrix));
        gl.uniform1f(uniforms.zScale, worldSize / (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)));
        gl.uniform3f(uniforms.uv, uv[0], uv[1], uv[2]);
        gl.bindTexture(gl.TEXTURE_2D, source.texture!);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
        gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        drawn++;
      }
      gl.bindVertexArray(null);
      gl.disable(gl.POLYGON_OFFSET_FILL);

      // 5. Ménage : on garde les tuiles récentes, dans la limite de la mémoire.
      if (tiles.size > MAX_TILES) {
        const old = [...tiles.values()].filter((t) => t.lastUsed < frame - 2).sort((a, b) => a.lastUsed - b.lastUsed);
        for (const tile of old.slice(0, tiles.size - MAX_TILES)) release(tile);
      }
      if (more || inFlight > 0) map.triggerRepaint();

      if (window.__photosMesure) gl.finish();
      renderMs += performance.now() - started;
      frames++;
    },

    setVintage(next) {
      if (next.layer === vintage.layer) return;
      // Les tuiles de l'ancienne époque ne servent plus.
      for (const tile of [...tiles.values()]) release(tile);
      vintage = next;
      map.triggerRepaint();
    },
    setCurtain(cssX) {
      curtainCss = cssX;
      map?.triggerRepaint();
    },
    setOpacity(value) {
      opacity = value;
      map?.triggerRepaint();
    },
    stats() {
      return { tiles: tiles.size, ready: [...tiles.values()].filter((t) => t.state === 'ready').length, renderMs, frames, buildMs, builds: totalBuilds, drawn, coveringMs };
    },
  };
}

// Mesure de développement : `window.__photosMesure = true` force la fin du dessin à chaque image (temps GPU compris).
declare global {
  interface Window {
    __photosMesure?: boolean;
  }
}
