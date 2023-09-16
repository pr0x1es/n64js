/*jshint jquery:true browser:true */
/*global $, n64js*/

import { padString, toHex, toString8, toString16, toString32 } from '../format.js';
import * as logger from '../logger.js';
import { Transform2D } from '../graphics/Transform2D.js';
import { Vector2 } from '../graphics/Vector2.js';
import { Vector3 } from '../graphics/Vector3.js';
import { makeColorTextRGBA16, makeColorTextRGBA, makeColorTextABGR } from './disassemble.js';
import * as gbi from './gbi.js';
import * as gbiMicrocode from './gbi_microcode.js';
import * as gbi0 from './gbi0.js';
import * as gbi1 from './gbi1.js';
import * as gbi2 from './gbi2.js';
import { RSPState } from './rsp_state.js';
import * as shaders from './shaders.js';
import { Texture, clampTexture } from './textures.js';

window.n64js = window.n64js || {};

const $textureOutput = $('#texture-content');
const $dlistContent = $('#dlist-content');

// Initialised in initDebugUI.
let $dlistOutput;
let $dlistState;
let $dlistScrub;

let numDisplayListsRendered = 0;

export let debugDisplayListRequested = false;
export let debugDisplayListRunning = false;

let debugNumOps = 0;
let debugBailAfter = -1;
let debugLastTask;  // The last task that we executed.
let debugStateTimeShown = -1;

class DebugController {
  constructor() {
    // This is updated as we're executing, so that we know which instruction to halt on.
    this.currentOp = 0;
  }
}
const debugController = new DebugController();

const textureCache = new Map();

let gl = null; // WebGL context for the canvas.

let frameBuffer;
let frameBufferTexture3D;  // For roms using display lists
let frameBufferTexture2D;  // For roms writing directly to the frame buffer
let nativeTransform;

// Scale factor to apply to the canvas.
// TODO: expose this on the UI somewhere.
let canvasScale = 1;

// An instance of GBIMicrocode.
let microcode;

let ramDV;

const state = new RSPState();

let fillShaderProgram;
let fillVertexPositionAttribute;
let fillFillColorUniform;

let blitShaderProgram;
let blitVertexPositionAttribute;
let blitTexCoordAttribute;
let blitSamplerUniform;

let rectVerticesBuffer;
let n64PositionsBuffer;
let n64ColorsBuffer;
let n64UVBuffer;

const kBlendModeUnknown = 0;
const kBlendModeOpaque = 1;
const kBlendModeAlphaTrans = 2;
const kBlendModeFade = 3;
const kBlendModeFog = 4;

// TODO: provide a HLE object and instantiate these in the constructor.
function getRamDataView() { return n64js.hardware().cachedMemDevice.mem.dataView; }

class NativeTransform {
  constructor() {
    this.initDimensions(320, 240);
  }

  initDimensions(viWidth, viHeight) {
    this.viWidth = viWidth;
    this.viHeight = viHeight;
    // Convert n64 framebuffer coordinates into normalised device coordinates (-1 to +1).
    this.n64FramebufferToDevice = new Transform2D(new Vector2(2 / viWidth, -2 / viHeight), new Vector2(-1, +1));
    // Displaylist-defined viewport - defaults to the entire screen.
    this.n64ViewportTransform = new Transform2D(new Vector2(viWidth, viHeight), new Vector2(0, 0));
  }

  setN64Viewport(t2d) {
    // TODO: is this affected by VI sx0/sy0 etc?
    this.n64ViewportTransform = t2d;
  }

  // Used by fillRec/texRect - ignores viewport.
  convertN64ToDisplay(n64Vec2) {
    return this.n64FramebufferToDevice.transform(n64Vec2);
  }
}

// Map to keep track of which unimplemented blend modes we've already warned about.
const loggedBlendModes = new Map();

function logUnhandledBlendMode(activeBlendMode, alphaCvgSel, cvgXAlpha) {
  if (loggedBlendModes.get(activeBlendMode)) {
    return;
  }
  loggedBlendModes.set(activeBlendMode, true);
  n64js.warn(`Unhandled blend mode: ${toString16(activeBlendMode)} = ${gbi.blendOpText(activeBlendMode)}, alphaCvgSel ${alphaCvgSel}, cvgXAlpha ${cvgXAlpha}`);
}

const loggedMicrocodes = new Map();

function logMicrocode(str, ucode) {
  if (loggedMicrocodes.get(str)) {
    return;
  }
  loggedMicrocodes.set(str, true);
  logger.log(`New RSP graphics ucode seen: ${str} = ucode ${ucode}`);
}

const X_NEG = 0x01; //left
const Y_NEG = 0x02; //bottom
const Z_NEG = 0x04; //far
const X_POS = 0x08; //right
const Y_POS = 0x10; //top
const Z_POS = 0x20; //near

function calculateLighting(normal) {
  const numLights = state.numLights;
  let r = state.lights[numLights].color.r;
  let g = state.lights[numLights].color.g;
  let b = state.lights[numLights].color.b;

  for (let l = 0; l < numLights; ++l) {
    const light = state.lights[l];
    const d = normal.dot(light.dir);
    if (d > 0.0) {
      r += light.color.r * d;
      g += light.color.g * d;
      b += light.color.b * d;
    }
  }

  r = Math.min(r, 1.0) * 255.0;
  g = Math.min(g, 1.0) * 255.0;
  b = Math.min(b, 1.0) * 255.0;
  const a = 255;

  return (a << 24) | (b << 16) | (g << 8) | r;
}

function previewVertexImpl(v0, n, dv, dis, light) {
  const cols = ['#', 'x', 'y', 'z', '?', 'u', 'v', light ? 'norm' : 'rgba'];

  let tip = '';
  tip += '<table class="vertex-table">';
  tip += `<tr><th>${cols.join('</th><th>')}</th></tr>\n`;

  for (let i = 0; i < n; ++i) {
    const base = i * 16;
    const normOrCol = light ? `${dv.getInt8(base + 12)},${dv.getInt8(base + 13)},${dv.getInt8(base + 14)}` : makeColorTextRGBA(dv.getUint32(base + 12));

    const v = [
      v0 + i,
      dv.getInt16(base + 0), // x
      dv.getInt16(base + 2), // y
      dv.getInt16(base + 4), // z
      dv.getInt16(base + 6), // ?
      dv.getInt16(base + 8), // u
      dv.getInt16(base + 10), // v
      normOrCol, // norm or rgba
    ];

    tip += `<tr><td>${v.join('</td><td>')}</td></tr>\n`;
  }
  tip += '</table>';
  dis.tip(tip);
}

function executeVertexImpl(v0, n, address, dis) {
  const light = state.geometryMode.lighting;
  const texgen = state.geometryMode.textureGen;
  const texgenlin = state.geometryMode.textureGenLinear;
  const dv = new DataView(ramDV.buffer, address);

  if (dis) {
    previewVertexImpl(v0, n, dv, dis, light);
  }

  if (v0 + n >= 64) { // FIXME or 80 for later GBI
    hleHalt('Too many verts');
    state.pc = 0;
    return;
  }

  const mvmtx = state.modelview[state.modelview.length - 1];
  const pmtx = state.projection[state.projection.length - 1];

  const wvp = pmtx.multiply(mvmtx);

  // Texture coords are provided in 11.5 fixed point format, so divide by 32 here to normalise
  const scaleS = state.texture.scaleS / 32.0;
  const scaleT = state.texture.scaleT / 32.0;

  const xyz = new Vector3();
  const normal = new Vector3();
  const transformedNormal = new Vector3();

  for (let i = 0; i < n; ++i) {
    const vtxBase = i * 16;
    const vertex = state.projectedVertices[v0 + i];

    vertex.set = true;

    xyz.x = dv.getInt16(vtxBase + 0);
    xyz.y = dv.getInt16(vtxBase + 2);
    xyz.z = dv.getInt16(vtxBase + 4);
    //const w = dv.getInt16(vtxBase + 6);
    const u = dv.getInt16(vtxBase + 8);
    const v = dv.getInt16(vtxBase + 10);

    const projected = vertex.pos;
    wvp.transformPoint(xyz, projected);

    //hleHalt(`${x},${y},${z}-&gt;${projected.x},${projected.y},${projected.z}`);

    // let clipFlags = 0;
    //      if (projected[0] < -projected[3]) clipFlags |= X_POS;
    // else if (projected[0] >  projected[3]) clipFlags |= X_NEG;

    //      if (projected[1] < -projected[3]) clipFlags |= Y_POS;
    // else if (projected[1] >  projected[3]) clipFlags |= Y_NEG;

    //      if (projected[2] < -projected[3]) clipFlags |= Z_POS;
    // else if (projected[2] >  projected[3]) clipFlags |= Z_NEG;
    // state.projectedVertices.clipFlags = clipFlags;

    if (light) {
      normal.x = dv.getInt8(vtxBase + 12);
      normal.y = dv.getInt8(vtxBase + 13);
      normal.z = dv.getInt8(vtxBase + 14);

      // calculate transformed normal
      mvmtx.transformNormal(normal, transformedNormal);
      transformedNormal.normaliseInPlace();

      vertex.color = calculateLighting(transformedNormal);

      if (texgen) {
        // retransform using wvp
        // wvp.transformNormal(normal, transformedNormal);
        // transformedNormal.normaliseInPlace();

        if (texgenlin) {
          vertex.u = 0.5 * (1.0 + transformedNormal.x);
          vertex.v = 0.5 * (1.0 + transformedNormal.y); // 1-y?
        } else {
          vertex.u = Math.acos(transformedNormal.x) / 3.141;
          vertex.v = Math.acos(transformedNormal.y) / 3.141;
        }
      } else {
        vertex.u = u * scaleS;
        vertex.v = v * scaleT;
      }
    } else {
      vertex.u = u * scaleS;
      vertex.v = v * scaleT;

      const r = dv.getUint8(vtxBase + 12);
      const g = dv.getUint8(vtxBase + 13);
      const b = dv.getUint8(vtxBase + 14);
      const a = dv.getUint8(vtxBase + 15);

      vertex.color = (a << 24) | (b << 16) | (g << 8) | r;
    }

    //const flag = dv.getUint16(vtxBase + 6);
    //const tu = dv.getInt16(vtxBase + 8);
    //const tv = dv.getInt16(vtxBase + 10);
    //const rgba = dv.getInt16(vtxBase + 12);    // nx/ny/nz/a
  }
}

function initWebGL(canvas) {
  if (gl) {
    return;
  }

  try {
    // Try to grab the standard context. If it fails, fallback to experimental.
    gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  } catch (e) {
    // Ignore errors.
  }

  // If we don't have a GL context, give up now
  if (!gl) {
    alert("Unable to initialize WebGL. Your browser may not support it.");
  }
}

function setProgramState(positions, colours, coords, textureEnabled, texGenEnabled, tileIdx) {
  setGLBlendMode();

  const cycleType = state.getCycleType();

  // TODO: I think it would make more sense to check if the texture is referenced in the combiner.
  let tile0, tile1;
  let texture0, texture1;
  if (textureEnabled) {
    const tileIdx0 = (tileIdx + 0) & 7;
    const tileIdx1 = (tileIdx + 1) & 7;

    tile0 = state.tiles[tileIdx0];
    tile1 = state.tiles[tileIdx1];

    texture0 = lookupTexture(tileIdx0);
    texture1 = (cycleType == gbi.CycleType.G_CYC_2CYCLE) ? lookupTexture(tileIdx1) : null;
  }
  let enableAlphaThreshold = false;
  let alphaThreshold = -1.0;

  if ((state.getAlphaCompareType() === gbi.AlphaCompare.G_AC_THRESHOLD)) {
    // TODO: it's unclear if this depends on CVG_X_ALPHA and ALPHA_CVG_SEL.
    alphaThreshold = ((state.blendColor >>> 0) & 0xff) / 255.0;
    enableAlphaThreshold = true;
  }

  const shader = getCurrentN64Shader(cycleType, enableAlphaThreshold);
  gl.useProgram(shader.program);

  // aVertexPosition
  gl.enableVertexAttribArray(shader.vertexPositionAttribute);
  gl.bindBuffer(gl.ARRAY_BUFFER, n64PositionsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.vertexAttribPointer(shader.vertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);

  // aVertexColor
  gl.enableVertexAttribArray(shader.vertexColorAttribute);
  gl.bindBuffer(gl.ARRAY_BUFFER, n64ColorsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, colours, gl.STATIC_DRAW);
  gl.vertexAttribPointer(shader.vertexColorAttribute, 4, gl.UNSIGNED_BYTE, true, 0, 0);

  // aTextureCoord
  gl.enableVertexAttribArray(shader.texCoordAttribute);
  gl.bindBuffer(gl.ARRAY_BUFFER, n64UVBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, coords, gl.STATIC_DRAW);
  gl.vertexAttribPointer(shader.texCoordAttribute, 2, gl.FLOAT, false, 0, 0);

  bindTexture(0, gl.TEXTURE0, tile0, texture0, texGenEnabled, shader.uSamplerUniform0, shader.uTexScaleUniform0, shader.uTexOffsetUniform0);
  bindTexture(1, gl.TEXTURE1, tile1, texture1, texGenEnabled, shader.uSamplerUniform1, shader.uTexScaleUniform1, shader.uTexOffsetUniform1);

  gl.uniform1f(shader.uAlphaThresholdUniform, alphaThreshold);

  gl.uniform4f(shader.uPrimColorUniform,
    ((state.primColor >>> 24) & 0xff) / 255.0,
    ((state.primColor >>> 16) & 0xff) / 255.0,
    ((state.primColor >>> 8) & 0xff) / 255.0,
    ((state.primColor >>> 0) & 0xff) / 255.0);
  gl.uniform4f(shader.uEnvColorUniform,
    ((state.envColor >>> 24) & 0xff) / 255.0,
    ((state.envColor >>> 16) & 0xff) / 255.0,
    ((state.envColor >>> 8) & 0xff) / 255.0,
    ((state.envColor >>> 0) & 0xff) / 255.0);
}

function bindTexture(slot, glTextureId, tile, texture, texGenEnabled, sampleUniform, texScaleUniform, texOffsetUniform) {
  gl.activeTexture(glTextureId);

  if (!texture) {
    gl.bindTexture(gl.TEXTURE_2D, null);
    return;
  }

  let uvOffsetU = tile.left;
  let uvOffsetV = tile.top;
  let uvScaleU = 1.0 / texture.nativeWidth;
  let uvScaleV = 1.0 / texture.nativeHeight;

  // Horrible hack for wetrix. For some reason uvs come out 2x what they should be.
  if (texture.width === 56 && texture.height === 29) {
    uvScaleU *= 0.5;
    uvScaleV *= 0.5;
  }

  // When texture coordinates are generated, they're already correctly
  // scaled. Maybe they should be generated in this coord space?
  if (texGenEnabled) {
    uvScaleU = 1;
    uvScaleV = 1;
    uvOffsetU = 0;
    uvOffsetV = 0;
  }

  uvScaleU *= shiftFactor(tile.shiftS);
  uvScaleV *= shiftFactor(tile.shiftT);

  gl.bindTexture(gl.TEXTURE_2D, texture.texture);
  gl.uniform1i(sampleUniform, slot);

  gl.uniform2f(texScaleUniform, uvScaleU, uvScaleV);
  gl.uniform2f(texOffsetUniform, uvOffsetU, uvOffsetV);

  if (state.getTextureFilterType() == gbi.TextureFilter.G_TF_POINT) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
  }

  // When not masking, Clamp S,T is ignored and clamping is implicitly enabled
  const clampS = tile.cmS === gbi.G_TX_CLAMP || (tile.maskS === 0);
  const clampT = tile.cmT === gbi.G_TX_CLAMP || (tile.maskT === 0);
  const mirrorS = tile.cmS === gbi.G_TX_MIRROR;
  const mirrorT = tile.cmT === gbi.G_TX_MIRROR;

  const modeS = clampS ? gl.CLAMP_TO_EDGE : (mirrorS ? gl.MIRRORED_REPEAT : gl.REPEAT);
  const modeT = clampT ? gl.CLAMP_TO_EDGE : (mirrorT ? gl.MIRRORED_REPEAT : gl.REPEAT);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, modeS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, modeT);
}

function shiftFactor(shift) {
  if (shift <= 10) {
    return 1 / (1 << shift);
  }
  return 1 << (16 - shift);
}

function setGLBlendMode() {
  // fragment coverage (0) or alpha (1)?
  const cvgXAlpha = state.getCoverageTimesAlpha();
  // use fragment coverage * fragment alpha
  const alphaCvgSel = state.getAlphaCoverageSelect();

  const cycleType = state.getCycleType();
  if (cycleType == gbi.CycleType.G_CYC_FILL || cycleType == gbi.CycleType.G_CYC_COPY) {
    // No blending in copy/fill modes, although they may set up alpha thresholding in the shader.
    gl.disable(gl.BLEND);
    return;
  }

  const blendMode = state.rdpOtherModeL >> gbi.G_MDSFT_BLENDER;
  const activeBlendMode = (cycleType === gbi.CycleType.G_CYC_2CYCLE ? blendMode : (blendMode >>> 2)) & 0x3333;

  let mode = kBlendModeUnknown;
  switch (activeBlendMode) {
    case 0x0000: // G_BL_CLR_IN, G_BL_A_IN, G_BL_CLR_IN, G_BL_1MA
    case 0x0302: // G_BL_CLR_IN, G_BL_0, G_BL_CLR_IN, G_BL_1
      mode = kBlendModeOpaque;
      break;
    // case 0x0321 = G_BL_CLR_IN, G_BL_0, G_BL_CLR_BL, G_BL_A_MEM - blend*alpha.

    case 0x0010: // G_BL_CLR_IN, G_BL_A_IN, G_BL_CLR_MEM, G_BL_1MA
    case 0x0011: // G_BL_CLR_IN, G_BL_A_IN, G_BL_CLR_MEM, G_BL_A_MEM
      // These modes either do a weighted sum of coverage (or coverage and alpha) or a plain alpha blend
      // If alphaCvgSel is 0, or if we're multiplying by fragment alpha, then we have alpha to blend with.
      if (!alphaCvgSel || cvgXAlpha) {
        mode = kBlendModeAlphaTrans;
      }
      break;

    case 0x0110: // G_BL_CLR_IN, G_BL_A_FOG, G_BL_CLR_MEM, G_BL_1MA, alphaCvgSel:false cvgXAlpha:false
      // FIXME: this needs to blend the input colour with the fog alpha, but we don't compute this yet.
      mode = kBlendModeOpaque;
      break;

    case 0x0310: // G_BL_CLR_IN, G_BL_0, G_BL_CLR_MEM, G_BL_1MA, alphaCvgSel:false cvgXAlpha:false
    case 0x1310: // G_BL_CLR_MEM, G_BL_0, G_BL_CLR_MEM, G_BL_1MA
      mode = kBlendModeFade;
      break;

    case 0x3110: // G_BL_CLR_FOG, G_BL_A_FOG, G_BL_CLR_MEM, G_BL_1MA
      mode = kBlendModeFog;
      break;
  }

  let logUnhandled = false;
  switch (mode) {
    case kBlendModeOpaque:
      gl.disable(gl.BLEND);
      break;
    case kBlendModeAlphaTrans:
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      gl.enable(gl.BLEND);
      break;
    case kBlendModeFade:
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.blendEquation(gl.FUNC_ADD);
      gl.enable(gl.BLEND);
      break;
    case kBlendModeFog:
      // TODO: figure out how to emulate this.
      // For now just render as opaque.
      logUnhandled = true;
      gl.disable(gl.BLEND);
      break;
    case kBlendModeUnknown:
      logUnhandled = true;
      gl.disable(gl.BLEND);
      break;
  }

  if (logUnhandled) {
    logUnhandledBlendMode(activeBlendMode, alphaCvgSel, cvgXAlpha);
  }
}

/**
 * Flushes the contents of a TriangleBuffer.
 * @param {TriangleBuffer} tb 
 * @returns 
 */
function flushTris(tb) {
  if (tb.empty()) {
    return;
  }

  const textureEnabled = state.geometryMode.texture;
  const texGenEnabled = state.geometryMode.lighting && state.geometryMode.textureGen;
  setProgramState(tb.positions,
    tb.colours,
    tb.coords,
    textureEnabled,
    texGenEnabled,
    state.texture.tile);

  initDepth();

  // texture filter

  if (state.geometryMode.cullFront || state.geometryMode.cullBack) {
    gl.enable(gl.CULL_FACE);
    const mode = (state.geometryMode.cullFront) ? gl.FRONT : gl.BACK;
    gl.cullFace(mode);
  } else {
    gl.disable(gl.CULL_FACE);
  }

  gl.drawArrays(gl.TRIANGLES, 0, tb.numTris * 3);
  //gl.drawArrays(gl.LINE_STRIP, 0, numTris * 3);
  tb.reset();
}

function fillRect(x0, y0, x1, y1, color) {
  setGLBlendMode();

  const display0 = nativeTransform.convertN64ToDisplay(new Vector2(x0, y0));
  const display1 = nativeTransform.convertN64ToDisplay(new Vector2(x1, y1));

  const vertices = [
    display1.x, display1.y, 0.0, 1.0,
    display0.x, display1.y, 0.0, 1.0,
    display1.x, display0.y, 0.0, 1.0,
    display0.x, display0.y, 0.0, 1.0,
  ];

  gl.useProgram(fillShaderProgram);

  // aVertexPosition
  gl.enableVertexAttribArray(fillVertexPositionAttribute);
  gl.bindBuffer(gl.ARRAY_BUFFER, rectVerticesBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  gl.vertexAttribPointer(fillVertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);

  // uFillColor
  gl.uniform4f(fillFillColorUniform, color.r, color.g, color.b, color.a);

  // Disable culling and depth testing.
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function texRect(tileIdx, x0, y0, x1, y1, s0, t0, s1, t1, flip) {
  // TODO: check scissor

  const display0 = nativeTransform.convertN64ToDisplay(new Vector2(x0, y0));
  const display1 = nativeTransform.convertN64ToDisplay(new Vector2(x1, y1));
  const depthSourcePrim = (state.rdpOtherModeL & gbi.DepthSource.G_ZS_PRIM) !== 0;
  const depth = depthSourcePrim ? state.primDepth : 0.0;

  const vertices = [
    display0.x, display0.y, depth, 1.0,
    display1.x, display0.y, depth, 1.0,
    display0.x, display1.y, depth, 1.0,
    display1.x, display1.y, depth, 1.0
  ];

  let uvs;

  if (flip) {
    uvs = [
      s0, t0,
      s0, t1,
      s1, t0,
      s1, t1,
    ];
  } else {
    uvs = [
      s0, t0,
      s1, t0,
      s0, t1,
      s1, t1,
    ];
  }

  const colours = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];

  setProgramState(new Float32Array(vertices), new Uint32Array(colours), new Float32Array(uvs),
    true /* textureEnabled */, false /*texGenEnabled*/, tileIdx);

  gl.disable(gl.CULL_FACE);

  const depthEnabled = depthSourcePrim ? true : false;
  if (depthEnabled) {
    initDepth();
  } else {
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function copyBackBufferToFrontBuffer(texture) {
  // Passing null binds the framebuffer to the canvas.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const vertices = [
    -1.0, -1.0, 0.0, 1.0,
    1.0, -1.0, 0.0, 1.0,
    -1.0, 1.0, 0.0, 1.0,
    1.0, 1.0, 0.0, 1.0
  ];

  const uvs = [
    0.0, 0.0,
    1.0, 0.0,
    0.0, 1.0,
    1.0, 1.0
  ];

  gl.useProgram(blitShaderProgram);

  const canvas = document.getElementById('display');
  gl.viewport(0, 0, canvas.width, canvas.height);

  // aVertexPosition
  gl.enableVertexAttribArray(blitVertexPositionAttribute);
  gl.bindBuffer(gl.ARRAY_BUFFER, n64PositionsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  gl.vertexAttribPointer(blitVertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);

  // aTextureCoord
  gl.enableVertexAttribArray(blitTexCoordAttribute);
  gl.bindBuffer(gl.ARRAY_BUFFER, n64UVBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
  gl.vertexAttribPointer(blitTexCoordAttribute, 2, gl.FLOAT, false, 0, 0);

  // uSampler
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(blitSamplerUniform, 0);

  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function initDepth() {
  // TODO: decal mode.
  //if (gRDPOtherMode.zmode == ZMODE_DEC) ...

  // Disable depth testing
  const zGeomMode = (state.geometryMode.zbuffer) !== 0;
  const zCmpRenderMode = (state.rdpOtherModeL & gbi.RenderMode.Z_CMP) !== 0;
  const zUpdRenderMode = (state.rdpOtherModeL & gbi.RenderMode.Z_UPD) !== 0;

  if ((zGeomMode && zCmpRenderMode) || zUpdRenderMode) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  } else {
    gl.disable(gl.DEPTH_TEST);
  }

  gl.depthMask(zUpdRenderMode);
}

// const ucodeSprite2d = {
//   0xbe: executeSprite2dScaleFlip,
//   0xbd: executeSprite2dDraw
// };

// const ucodeDKR = {
//   0x05:  executeDMATri,
//   0x07:  executeGBI1_DLInMem,
// };

function buildUCodeTables(ucode) {
  microcode = null;

  switch (ucode) {
    case gbiMicrocode.kUCode_GBI0:
    case gbiMicrocode.kUCode_GBI0_DKR:
    case gbiMicrocode.kUCode_GBI0_SE:
    case gbiMicrocode.kUCode_GBI0_PD:
      microcode = new gbi0.GBI0(ucode, state, ramDV);
      break;
    case gbiMicrocode.kUCode_GBI0_GE:
      microcode = new gbi0.GBI0GE(ucode, state, ramDV);
      break;
    case gbiMicrocode.kUCode_GBI0_WR:
      microcode = new gbi0.GBI0WR(ucode, state, ramDV);
      break;
    case gbiMicrocode.kUCode_GBI1:
    case gbiMicrocode.kUCode_GBI1_LL:
      microcode = new gbi1.GBI1(ucode, state, ramDV);
      break;
    case gbiMicrocode.kUCode_GBI2:
    case gbiMicrocode.kUCode_GBI2_CONKER:
      microcode = new gbi2.GBI2(ucode, state, ramDV);
      break;
    default:
      logger.log(`unhandled ucode during table init: ${ucode}`);
      microcode = new gbi0.GBI0(ucode, state, ramDV);
  }

  // Build a copy of the table as an array
  const table = [];
  for (let i = 0; i < 256; ++i) {
    let fn = microcode.getHandler(i);
    if (fn) {
      fn = fn.bind(microcode);
    } else {
      fn = executeUnknown;
    }
    table.push(fn);
  }

  // Patch in specific overrides
  if (microcode) {
    // TODO: pass rendering object to microcode constructor.
    microcode.flushTris = flushTris;
    microcode.executeVertexImpl = executeVertexImpl;
    microcode.debugController = debugController;
    microcode.hleHalt = hleHalt;
    microcode.fillRect = fillRect;
    microcode.texRect = texRect;
    microcode.nativeTransform = nativeTransform;
    microcode.gl = gl;
  }
  return table;
}

function executeUnknown(cmd0, cmd1) {
  hleHalt(`Unknown display list op ${toString8(cmd0 >>> 24)}`);
  state.pc = 0;
}

export function presentBackBuffer() {
  n64js.onPresent();

  if (numDisplayListsRendered !== 0) {
    copyBackBufferToFrontBuffer(frameBufferTexture3D);
    return;
  }

  // If no display lists executed, interpret framebuffer as bytes
  initViScales();    // resize canvas to match VI res.

  const vi = n64js.hardware().viRegDevice;
  const pixels = vi.renderBackBuffer();
  if (!pixels) {
    return;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameBufferTexture2D);

  if (vi.is32BitMode) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, vi.screenWidth, vi.screenHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } else if (vi.is16BitMode) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, vi.screenWidth, vi.screenHeight, 0, gl.RGBA, gl.UNSIGNED_SHORT_5_5_5_1, pixels);
  } else {
    // Invalid mode.
  }

  copyBackBufferToFrontBuffer(frameBufferTexture2D);
}

function initViScales() {
  const vi = n64js.hardware().viRegDevice;
  const dims = vi.computeDimensions();
  if (!dims) {
    return;
  }

  nativeTransform.initDimensions(dims.srcWidth, dims.srcHeight);

  const canvas = document.getElementById('display');
  canvas.width = dims.screenWidth * canvasScale;
  canvas.height = dims.screenHeight * canvasScale;
}

class Disassembler {
  constructor() {
    this.$currentDis = $('<pre></pre>');
    this.$span = undefined;
    this.numOps = 0;
  }

  begin(pc, cmd0, cmd1, depth) {
    const indent = (new Array(depth + 1)).join('  ');
    const pcStr = ' '; //  ` [${toHex(pc, 32)}] `

    this.$span = $(`<span class="hle-instr" id="I${this.numOps}" />`);
    this.$span.append(`${padString(this.numOps, 5)}${pcStr}${toHex(cmd0, 32)}${toHex(cmd1, 32)} ${indent}`);
    this.$currentDis.append(this.$span);
  }

  text(t) {
    this.$span.append(t);
  }

  tip(t) {
    const $d = $(`<div class="dl-tip">${t}</div>`);
    $d.hide();
    this.$span.append($d);
  }

  end() {
    this.$span.append('<br>');
    this.numOps++;
  }

  finalise = function () {
    $dlistOutput.html(this.$currentDis);
    this.$currentDis.find('.dl-tip').parent().click(function () {
      $(this).find('.dl-tip').toggle();
    });
    // this.$currentDis.find('.dl-branch').click(function () {
    // });
  }

  rgba8888(col) { return makeColorTextRGBA(col); }
  rgba5551(col) { return makeColorTextRGBA16(col); }
}

function buildStateTab() {
  const $table = $('<table class="table table-condensed dl-debug-table" style="width: auto;"></table>');
  const $tr = $('<tr />');

  for (let i in state.geometryMode) {
    if (state.geometryMode.hasOwnProperty(i)) {
      const $td = $(`<td>${i}</td>`);
      if (state.geometryMode[i]) {
        $td.css('background-color', '#AFF4BB');
      }
      $tr.append($td);
    }
  }

  $table.append($tr);
  return $table;
}

function buildRDPTab() {
  const l = state.rdpOtherModeL;
  const h = state.rdpOtherModeH;
  const vals = new Map([
    ['alphaCompare', gbi.AlphaCompare.nameOf(l & gbi.G_AC_MASK)],
    ['depthSource', gbi.DepthSource.nameOf(l & gbi.G_ZS_MASK)],
    ['renderMode', gbi.getRenderModeText(l)],
    ['alphaDither', gbi.AlphaDither.nameOf(h & gbi.G_AD_MASK)],
    ['colorDither', gbi.ColorDither.nameOf(h & gbi.G_CD_MASK)],
    ['combineKey', gbi.CombineKey.nameOf(h & gbi.G_CK_MASK)],
    ['textureConvert', gbi.TextureConvert.nameOf(h & gbi.G_TC_MASK)],
    ['textureFilter', gbi.TextureFilter.nameOf(h & gbi.G_TF_MASK)],
    ['textureLUT', gbi.TextureLUT.nameOf(h & gbi.G_TT_MASK)],
    ['textureLOD', gbi.TextureLOD.nameOf(h & gbi.G_TL_MASK)],
    ['texturePersp', gbi.TexturePerspective.nameOf(h & gbi.G_TP_MASK)],
    ['textureDetail', gbi.TextureDetail.nameOf(h & gbi.G_TD_MASK)],
    ['cycleType', gbi.CycleType.nameOf(h & gbi.G_CYC_MASK)],
    ['pipelineMode', gbi.PipelineMode.nameOf(h & gbi.G_PM_MASK)],
  ]);

  const $table = $('<table class="table table-condensed dl-debug-table" style="width: auto;"></table>');
  for (let [name, value] of vals) {
    let $tr = $(`<tr><td>${name}</td><td>${value}</td></tr>`);
    $table.append($tr);
  }
  return $table;
}

function buildColorsTable() {
  const colors = [
    'fillColor',
    'envColor',
    'primColor',
    'blendColor',
    'fogColor',
  ];

  const $table = $('<table class="table table-condensed dl-debug-table" style="width: auto;"></table>');
  for (let color of colors) {
    let row = $(`<tr><td>${color}</td><td>${makeColorTextRGBA(state[color])}</td></tr>`);
    $table.append(row);
  }
  return $table;
}

function buildCombinerTab() {
  const $p = $('<pre class="combine"></pre>');
  $p.append(gbi.CycleType.nameOf(state.getCycleType()) + '\n');
  $p.append(buildColorsTable());
  $p.append(shaders.getCombinerText(state.combine.hi, state.combine.lo));
  return $p;
}

function buildTexture(tileIdx) {
  const texture = lookupTexture(tileIdx);
  if (texture) {
    const kScale = 8;
    return texture.createScaledCanvas(kScale);
  }
}

function buildTexturesTab() {
  const $d = $('<div />');
  $d.append(buildTilesTable());
  for (let i = 0; i < 8; ++i) {
    let $t = buildTexture(i);
    if ($t) {
      $d.append($t);
    }
  }
  return $d;
}

function buildTilesTable() {
  const tileFields = [
    'tile #',
    'format',
    'size',
    'line',
    'tmem',
    'palette',
    'cmS',
    'maskS',
    'shiftS',
    'cmT',
    'maskT',
    'shiftT',
    'left',
    'top',
    'right',
    'bottom',
    'width',
    'height',
    'unmasked w',
    'unmasked h',
  ];

  const $table = $('<table class="table table-condensed dl-debug-table" style="width: auto"></table>');
  const $headingTR = $(`<tr><th>${tileFields.join('</th><th>')}</th></tr>`);
  $table.append($headingTR);

  for (let tileIdx = 0; tileIdx < state.tiles.length; ++tileIdx) {
    const tile = state.tiles[tileIdx];

    // Ignore any tiles that haven't been set up.
    if (tile.format === -1) {
      continue;
    }

    const vals = [];
    vals.push(gbi.getTileText(tileIdx));
    vals.push(gbi.ImageFormat.nameOf(tile.format));
    vals.push(gbi.ImageSize.nameOf(tile.size));
    vals.push(tile.line);
    vals.push(tile.tmem);
    vals.push(tile.palette);
    vals.push(gbi.getClampMirrorWrapText(tile.cmS));
    vals.push(tile.maskS);
    vals.push(tile.shiftS);
    vals.push(gbi.getClampMirrorWrapText(tile.cmT));
    vals.push(tile.maskT);
    vals.push(tile.shiftT);
    vals.push(tile.left);
    vals.push(tile.top);
    vals.push(tile.right);
    vals.push(tile.bottom);
    vals.push(tile.width);
    vals.push(tile.height);
    vals.push(tile.unmaskedWidth);
    vals.push(tile.unmaskedHeight);

    const tr = $(`<tr><td>${vals.join('</td><td>')}</td></tr>`);
    $table.append(tr);
  }

  return $table;
}

function buildVerticesTab() {
  const vtxFields = [
    'vtx #',
    'x',
    'y',
    'z',
    'px',
    'py',
    'pz',
    'pw',
    'color',
    'u',
    'v'
  ];

  const $table = $('<table class="table table-condensed dl-debug-table" style="width: auto"></table>');
  const headingTR = $(`<tr><th>${vtxFields.join('</th><th>')}</th></tr>`);
  $table.append(headingTR);

  for (let i = 0; i < state.projectedVertices.length; ++i) {
    const vtx = state.projectedVertices[i];
    if (!vtx.set) {
      continue;
    }

    const x = vtx.pos.x / vtx.pos.w;
    const y = vtx.pos.y / vtx.pos.w;
    const z = vtx.pos.z / vtx.pos.w;

    const vals = [];
    vals.push(i);
    vals.push(x.toFixed(3));
    vals.push(y.toFixed(3));
    vals.push(z.toFixed(3));
    vals.push(vtx.pos.x.toFixed(3));
    vals.push(vtx.pos.y.toFixed(3));
    vals.push(vtx.pos.z.toFixed(3));
    vals.push(vtx.pos.w.toFixed(3));
    vals.push(makeColorTextABGR(vtx.color));
    vals.push(vtx.u.toFixed(3));
    vals.push(vtx.v.toFixed(3));

    const tr = $(`<tr><td>${vals.join('</td><td>')}</td></tr>`);
    $table.append(tr);
  }

  return $table;
}

function updateStateUI() {
  $dlistState.find('#dl-geometrymode-content').html(buildStateTab());
  $dlistState.find('#dl-vertices-content').html(buildVerticesTab());
  $dlistState.find('#dl-textures-content').html(buildTexturesTab());
  $dlistState.find('#dl-combiner-content').html(buildCombinerTab());
  $dlistState.find('#dl-rdp-content').html(buildRDPTab());
}

function showDebugDisplayListUI() {
  $('.debug').show();
  $('#dlist-tab').tab('show');
}

function hideDebugDisplayListUI() {
  $('.debug').hide();
}

export function toggleDebugDisplayList() {
  if (debugDisplayListRunning) {
    hideDebugDisplayListUI();
    debugBailAfter = -1;
    debugDisplayListRunning = false;
    n64js.toggleRun();
  } else {
    showDebugDisplayListUI();
    debugDisplayListRequested = true;
  }
}

// This is called repeatedly so that we can update the UI.
// We can return false if we don't render anything, but it's useful to keep re-rendering so that we can plot a framerate graph
export function debugDisplayList() {
  if (debugStateTimeShown == -1) {
    // Build some disassembly for this display list
    const disassembler = new Disassembler();
    processDList(debugLastTask, disassembler, -1);
    disassembler.finalise();

    // Update the scrubber based on the new length of disassembly
    debugNumOps = disassembler.numOps > 0 ? (disassembler.numOps - 1) : 0;
    setScrubRange(debugNumOps);

    // If debugBailAfter hasn't been set (e.g. by hleHalt), stop at the end of the list
    const timeToShow = (debugBailAfter == -1) ? debugNumOps : debugBailAfter;
    setScrubTime(timeToShow);
  }

  // Replay the last display list using the captured task/ram
  processDList(debugLastTask, null, debugBailAfter);

  // Only update the state display when needed, otherwise it's impossible to
  // debug the dom in Chrome
  if (debugStateTimeShown !== debugBailAfter) {
    updateStateUI();
    debugStateTimeShown = debugBailAfter;
  }

  return true;
}

export function hleGraphics(task) {
  // Bodgily track these parameters so that we can call again with the same params.
  debugLastTask = task;

  // Force the cpu to stop at the point that we render the display list.
  if (debugDisplayListRequested) {
    debugDisplayListRequested = false;

    // Finally, break execution so we can keep replaying the display list
    // before any other state changes.
    n64js.breakEmulationForDisplayListDebug();

    debugStateTimeShown = -1;
    debugDisplayListRunning = true;
  }

  processDList(task, null, -1);
}

const ucodeOverrides = new Map([
  [0x60256efc, gbiMicrocode.kUCode_GBI2_CONKER],	// "RSP Gfx ucode F3DEXBG.NoN fifo 2.08  Yoshitaka Yasumoto 1999 Nintendo.", "Conker's Bad Fur Day"
  [0x6d8bec3e, gbiMicrocode.kUCode_GBI1_LL],	// "Dark Rift"
  [0x0c10181a, gbiMicrocode.kUCode_GBI0_DKR],	// "Diddy Kong Racing (v1.0)"
  [0x713311dc, gbiMicrocode.kUCode_GBI0_DKR],	// "Diddy Kong Racing (v1.1)"
  [0x23f92542, gbiMicrocode.kUCode_GBI0_GE],	// "RSP SW Version: 2.0G, 09-30-96", "GoldenEye 007"
  [0x169dcc9d, gbiMicrocode.kUCode_GBI0_DKR],	// "Jet Force Gemini"											
  [0x26da8a4c, gbiMicrocode.kUCode_GBI1_LL],	// "Last Legion UX"				
  [0xcac47dc4, gbiMicrocode.kUCode_GBI0_PD],	// "Perfect Dark (v1.1)"
  [0x6cbb521d, gbiMicrocode.kUCode_GBI0_SE],	// "RSP SW Version: 2.0D, 04-01-96", "Star Wars - Shadows of the Empire (v1.0)"
  [0xdd560323, gbiMicrocode.kUCode_GBI1_LL],	// "Toukon Road - Brave Spirits"				
  [0x64cc729d, gbiMicrocode.kUCode_GBI0_WR],	// "RSP SW Version: 2.0D, 04-01-96", "Wave Race 64"

  [0xd73a12c4, gbiMicrocode.kUCode_GBI0], // Fish demo
  [0x313f038b, gbiMicrocode.kUCode_GBI0], // Pilotwings
]);

function processDList(task, disassembler, bailAfter) {
  // Update a counter to tell the video code that we've rendered something.
  numDisplayListsRendered++;
  if (!gl) {
    return;
  }

  const str = task.detectVersionString();
  const hash = task.computeMicrocodeHash();
  let ucode = ucodeOverrides.get(hash);
  if (ucode === undefined) {
    const prefixes = ['F3', 'L3', 'S2DEX'];
    let index = -1;
    for (let prefix of prefixes) {
      index = str.indexOf(prefix);
      if (index >= 0) {
        break;
      }
    }

    // Assume this is GBI0 unless we get a better match.
    ucode = gbiMicrocode.kUCode_GBI0;
    if (index >= 0) {
      if (str.indexOf('fifo', index) >= 0 || str.indexOf('xbux', index) >= 0) {
        ucode = (str.indexOf('S2DEX') >= 0) ? gbiMicrocode.kUCode_GBI2_SDEX : gbiMicrocode.kUCode_GBI2;
      } else {
        ucode = (str.indexOf('S2DEX') >= 0) ? gbiMicrocode.kUCode_GBI1_SDEX : gbiMicrocode.kUCode_GBI1;
      }
    }
  }

  logMicrocode(str, ucode);

  const ram = getRamDataView();
  const ucodeTable = resetState(ucode, ram, task.data_ptr);

  // Render everything to the back buffer. This prevents horrible flickering
  // if due to webgl clearing our context between updates.
  gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);

  initViScales();

  // Set the viewport to match the framebuffer dimensions.
  gl.viewport(0, 0, frameBuffer.width, frameBuffer.height);

  if (disassembler) {
    debugController.currentOp = 0;

    while (state.pc !== 0) {
      const pc = state.pc;
      const cmd0 = ram.getUint32(pc + 0);
      const cmd1 = ram.getUint32(pc + 4);
      state.pc += 8;

      disassembler.begin(pc, cmd0, cmd1, state.dlistStack.length);
      ucodeTable[cmd0 >>> 24](cmd0, cmd1, disassembler);
      disassembler.end();
      debugController.currentOp++;
    }
  } else {
    // Vanilla loop, no disassembler to worry about
    debugController.currentOp = 0;
    while (state.pc !== 0) {
      const pc = state.pc;
      const cmd0 = ram.getUint32(pc + 0);
      const cmd1 = ram.getUint32(pc + 4);
      state.pc += 8;

      ucodeTable[cmd0 >>> 24](cmd0, cmd1);

      if (bailAfter > -1 && debugController.currentOp >= bailAfter) {
        break;
      }
      debugController.currentOp++;
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function resetState(ucode, ram, pc) {
  ramDV = ram;
  state.reset(pc);
  return buildUCodeTables(ucode, ramDV);
}

function setScrubText(x, max) {
  $dlistScrub.find('.scrub-text').html(`uCode op ${x}/${max}.`);
}

function setScrubRange(max) {
  $dlistScrub.find('input').attr({
    min: 0,
    max: max,
    value: max
  });
  setScrubText(max, max);
}

function setScrubTime(t) {
  debugBailAfter = t;
  setScrubText(debugBailAfter, debugNumOps);

  const $instr = $dlistOutput.find(`#I${debugBailAfter}`);

  $dlistOutput.scrollTop($dlistOutput.scrollTop() + $instr.position().top -
    $dlistOutput.height() / 2 + $instr.height() / 2);

  $dlistOutput.find('.hle-instr').removeAttr('style');
  $instr.css('background-color', 'rgb(255,255,204)');
}

function initDebugUI() {
  const $dlistControls = $dlistContent.find('#controls');

  debugBailAfter = -1;
  debugNumOps = 0;

  $dlistControls.find('#rwd').click(() => {
    if (debugDisplayListRunning && debugBailAfter > 0) {
      setScrubTime(debugBailAfter - 1);
    }
  });
  $dlistControls.find('#fwd').click(() => {
    if (debugDisplayListRunning && debugBailAfter < debugNumOps) {
      setScrubTime(debugBailAfter + 1);
    }
  });
  $dlistControls.find('#stop').click(() => {
    toggleDebugDisplayList();
  });

  $dlistScrub = $dlistControls.find('.scrub');
  $dlistScrub.find('input').change(function () {
    setScrubTime($(this).val() | 0);
  });
  setScrubRange(0);

  $dlistState = $dlistContent.find('.hle-state');

  $dlistOutput = $('<div class="hle-disasm"></div>');
  $('#adjacent-debug').empty().append($dlistOutput);
}

export function initialiseRenderer($canvas) {
  initDebugUI();

  const canvas = $canvas[0];
  initWebGL(canvas); // Initialize the GL context

  // Only continue if WebGL is available and working
  if (!gl) {
    return;
  }

  frameBufferTexture2D = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frameBufferTexture2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // We call texImage2D to initialise frameBufferTexture2D with the correct dimensions when it's used.

  frameBuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
  frameBuffer.width = 640;
  frameBuffer.height = 480;

  // Create a texture for color data and attach to the framebuffer.
  frameBufferTexture3D = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frameBufferTexture3D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frameBuffer.width, frameBuffer.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frameBufferTexture3D, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Create a render buffer and attach to the framebuffer.
  const renderbuffer = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, frameBuffer.width, frameBuffer.height);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);

  // Passing null binds the framebuffer to the canvas.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  fillShaderProgram = shaders.createShaderProgram(gl, "fill-shader-vs", "fill-shader-fs");
  fillVertexPositionAttribute = gl.getAttribLocation(fillShaderProgram, "aVertexPosition");
  fillFillColorUniform = gl.getUniformLocation(fillShaderProgram, "uFillColor");

  blitShaderProgram = shaders.createShaderProgram(gl, "blit-shader-vs", "blit-shader-fs");
  blitVertexPositionAttribute = gl.getAttribLocation(blitShaderProgram, "aVertexPosition");
  blitTexCoordAttribute = gl.getAttribLocation(blitShaderProgram, "aTextureCoord");
  blitSamplerUniform = gl.getUniformLocation(blitShaderProgram, "uSampler");

  rectVerticesBuffer = gl.createBuffer();
  n64PositionsBuffer = gl.createBuffer();
  n64ColorsBuffer = gl.createBuffer();
  n64UVBuffer = gl.createBuffer();

  nativeTransform = new NativeTransform();
}

export function resetRenderer() {
  textureCache.clear();
  $textureOutput.html('');
  ramDV = getRamDataView();
}

function getCurrentN64Shader(cycleType, enableAlphaThreshold) {
  const mux0 = state.combine.hi;
  const mux1 = state.combine.lo;

  return shaders.getOrCreateN64Shader(gl, mux0, mux1, cycleType, enableAlphaThreshold);
}

/**
 * Looks up the texture defined at the specified tile index.
 * @param {number} tileIdx
 * @return {?Texture}
 */
function lookupTexture(tileIdx) {
  const tile = state.tiles[tileIdx];
  // Skip empty tiles - this is primarily for the debug ui.
  if (tile.line === 0) {
    return null;
  }

  // FIXME: we can cache this if tile/tmem state hasn't changed since the last draw call.
  const hash = state.tmem.calculateCRC(tile);

  // Check if the texture is already cached.
  // The cacheID should include all the state that can affect how the texture is constructed.
  const cacheID = `${toString32(hash)}_${tile.format}_${tile.size}_${tile.width}_${tile.height}_${tile.palette}`;
  if (textureCache.has(cacheID)) {
    return textureCache.get(cacheID);
  }
  const texture = decodeTexture(tile, state.getTextureLUTType(), cacheID);
  textureCache.set(cacheID, texture);
  return texture;
}

/**
 * Decodes the texture defined by the specified tile.
 * @param {!Tile} tile
 * @param {number} tlutFormat
 * @return {?Texture}
 */
function decodeTexture(tile, tlutFormat, cacheID) {
  const texture = new Texture(gl, tile.width, tile.height);
  if (!texture.$canvas[0].getContext) {
    return null;
  }

  $textureOutput.append(
    `${cacheID}: ${gbi.ImageFormat.nameOf(tile.format)}, ${gbi.ImageSize.nameOf(tile.size)},${tile.width}x${tile.height}, <br>`);

  const ctx = texture.$canvas[0].getContext('2d');
  const imgData = ctx.createImageData(texture.nativeWidth, texture.nativeHeight);

  const handled = state.tmem.convertTexels(tile, tlutFormat, imgData);
  if (handled) {
    clampTexture(imgData, tile.width, tile.height);

    ctx.putImageData(imgData, 0, 0);

    $textureOutput.append(texture.$canvas);
    $textureOutput.append('<br>');
  } else {
    const msg = `${gbi.ImageFormat.nameOf(tile.format)}/${gbi.ImageSize.nameOf(tile.size)} is unhandled`;
    $textureOutput.append(msg);
    // FIXME: fill with placeholder texture
    hleHalt(msg);
  }

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture.$canvas[0]);

  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function hleHalt(msg) {
  if (!debugDisplayListRunning) {
    n64js.ui().displayWarning(msg);

    // Ensure the CPU emulation stops immediately
    n64js.breakEmulationForDisplayListDebug();

    // Ensure the ui is visible
    showDebugDisplayListUI();

    // We're already executing a display list, so clear the Requested flag, set Running
    debugDisplayListRequested = false;
    debugDisplayListRunning = true;

    // End set up the context
    debugBailAfter = debugController.currentOp;
    debugStateTimeShown = -1;
  }
}
