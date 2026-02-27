// ========================================================
// 3D お絵描き遊び場  +  ちびっこ探検ゲーム
// Three.js r160  (import-map via CDN)
// ========================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';

/* ─── Physics constants ─── */
const GRAVITY = -20;
const JUMP_VEL = 9;
const MOVE_SPD = 6;
const PLAYER_H = 0.9;      // capsule height (standing)
const PLAYER_H_CROUCH = 0.45;  // capsule height (crouching)
const PLAYER_R = 0.32;     // capsule radius
const SLIDE_MAX_SPD = 30;  // 最高スライド速度 (m/s) ← 2倍に増速
const SLOPE_LIMIT = 0.707; // cos(45°): これ以下の法線Y成分は「壁」とみなす

/* ─── App state ─── */
let mode = 'draw'; // 'draw' | 'play'
let selectedPart = 'board';
let selectedObj = null;
let tMode = 'translate';
let sceneObjects = [];
let currentColor = '#6c63ff';
let undoStack = [];
let placingMode = false;
let holeMode = null;    // 'box' | 'hemisphere' | 'sphere' | null
let holeTMode = 'translate'; // 'translate' | 'scale'
const csgEvaluator = new Evaluator();
csgEvaluator.attributes = ['position', 'normal'];

/* ─── Ghost (preview) mesh for hole tool ─── */
let ghostMesh = null;

/* ─── Hole geometry factory (unit scale; size controlled via ghostMesh.scale) ─── */
function makeHoleGeo(holeType) {
    if (holeType === 'box') {
        return new THREE.BoxGeometry(1, 1, 1);
    } else if (holeType === 'hemisphere') {
        // ドーム (上半球) ＋ フタ (円盤) を結合して水密な半球を生成
        const dome = new THREE.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        const cap = new THREE.CircleGeometry(0.5, 32);
        cap.rotateX(-Math.PI / 2); // y=0 の平面に置き、法線を下向き（外向き）にする
        return mergeGeometries([dome, cap]);
    } else {
        return new THREE.SphereGeometry(0.5, 32, 16);
    }
}

/* ─── Ghost helpers ─── */
function showGhost() {
    // Remove existing ghost
    if (ghostMesh) {
        holeTransform.detach();
        scene.remove(ghostMesh);
        ghostMesh.geometry.dispose();
        ghostMesh = null;
    }
    if (!holeMode) return;

    const geo = makeHoleGeo(holeMode);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xff4444,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
    });
    ghostMesh = new THREE.Mesh(geo, mat);
    ghostMesh.scale.set(2, 2, 2); // default size

    // Place at center of existing scene objects (or origin)
    if (sceneObjects.length) {
        const bb = new THREE.Box3();
        sceneObjects.forEach(o => bb.expandByObject(o));
        const c = new THREE.Vector3();
        bb.getCenter(c);
        ghostMesh.position.copy(c);
        ghostMesh.position.y = Math.max(bb.min.y + 1, 1);
    } else {
        ghostMesh.position.set(0, 1, 0);
    }

    scene.add(ghostMesh);
    holeTransform.attach(ghostMesh);
    holeTMode = 'translate';
    holeTransform.setMode('translate');
    updateHoleModeBtns();
}

function cancelHoleMode() {
    holeMode = null;
    if (ghostMesh) {
        holeTransform.detach();
        scene.remove(ghostMesh);
        ghostMesh.geometry.dispose();
        ghostMesh = null;
    }
    document.querySelectorAll('.part-btn, .hole-btn').forEach(b => b.classList.remove('active'));
    updateHoleModeBtns();
    placingMode = false;
}

function updateHoleModeBtns() {
    document.getElementById('hole-btn-translate')?.classList.toggle('active', holeTMode === 'translate');
    document.getElementById('hole-btn-scale')?.classList.toggle('active', holeTMode === 'scale');
}

/* ─── Player state ─── */
const player = {
    vel: new THREE.Vector3(),
    onGround: false,
    yaw: 0, pitch: 0,
    isCrouching: false,
    isSliding: false,
    groundNormal: new THREE.Vector3(0, 1, 0),  // 今立っている面の法線
};
const keys = {};

/* ════════════════════════════════════════════
   Three.js bootstrap
   ════════════════════════════════════════════ */
const canvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d27);
scene.fog = new THREE.FogExp2(0x1a1d27, 0.025);

// ─── スカイ円柱: 縦方向の歪みがない円柱形の背景 ───
// 球面と違い、縦方向の歪みがゼロ。底辺 y=0（地平線）に配置。
const skyDomeGeo = new THREE.CylinderGeometry(
    240,    // 上面半径
    240,    // 下面半径
    180,    // 高さ (bottom y=0 → top y=180)
    64,     // 周方向の分割数
    1,      // 高さ方向の分割数
    true    // 上下のキャップなし（開口部）
);
// 中心が y=0 なので y=90 上にずらして底辺を地面（y=0）に合わせる
skyDomeGeo.translate(0, 90, 0);

// UV の U 座標を 10 倍して横 10 枚タイルに（縦は歪みなしで1枚そのまま）
const _uvAttr = skyDomeGeo.attributes.uv;
for (let i = 0; i < _uvAttr.count; i++) {
    _uvAttr.setX(i, _uvAttr.getX(i) * 2);
}
_uvAttr.needsUpdate = true;

const skyTex = new THREE.TextureLoader().load('Haikei.png');
skyTex.wrapS = THREE.RepeatWrapping;
const skyDomeMat = new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,  // 内側から見る
    fog: false,
});
const skyDome = new THREE.Mesh(skyDomeGeo, skyDomeMat);
scene.add(skyDome);

// ─── 空ドーム: 円柱の上端にかぶせる上半球 ───
// 半径 240 の上半球を y=180 に配置（円柱の上端にぴったり合わせる）
const skyCapGeo = new THREE.SphereGeometry(
    240,          // 半径
    64,           // 横分割数
    32,           // 縦分割数
    0,            // phiStart
    Math.PI * 2,  // phiLength（全周）
    0,            // thetaStart（頂上から）
    Math.PI / 2   // thetaLength（上半球のみ）
);
skyCapGeo.translate(0, 180, 0); // 円柱上端 y=180 に底辺を合わせる

// UV: U×2（横2枚タイル）、V を [0.5,1]→[0,1] にリマップ（画像全体を使う）
const _capUV = skyCapGeo.attributes.uv;
for (let i = 0; i < _capUV.count; i++) {
    _capUV.setX(i, _capUV.getX(i) * 2);
    _capUV.setY(i, (_capUV.getY(i) - 0.5) * 2);
}
_capUV.needsUpdate = true;

const skyCapTex = new THREE.TextureLoader().load('SoraDome.png');
skyCapTex.wrapS = THREE.RepeatWrapping;
const skyCapMat = new THREE.MeshBasicMaterial({
    map: skyCapTex,
    side: THREE.BackSide,
    fog: false,
});
const skyCap = new THREE.Mesh(skyCapGeo, skyCapMat);
scene.add(skyCap);


/* ─── Cameras ─── */
const drawCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
drawCamera.position.set(8, 8, 12);

const gameCamera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);

/* ─── Orbit + Transform controls (for parts) ─── */
const orbit = new OrbitControls(drawCamera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 1;
orbit.maxDistance = 120;

const tfCtrl = new TransformControls(drawCamera, renderer.domElement);
tfCtrl.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
scene.add(tfCtrl);

/* ─── TransformControls for hole ghost ─── */
const holeTransform = new TransformControls(drawCamera, renderer.domElement);
holeTransform.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
holeTransform.setMode('translate');
scene.add(holeTransform);

/* ─── Lights ─── */
scene.add(new THREE.AmbientLight(0xffffff, 0.6));

const sun = new THREE.DirectionalLight(0xfffbe6, 1.6);
sun.position.set(20, 40, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 200 });
scene.add(sun);

scene.add(new THREE.HemisphereLight(0x9bb0ff, 0x444460, 0.5));

/* ─── Grid / Ground ─── */
scene.add(new THREE.GridHelper(60, 60, 0x2d3154, 0x222540));

const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x12141f, roughness: 0.9 })
);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.position.y = -0.005;
groundMesh.receiveShadow = true;
groundMesh.name = '__ground__';
scene.add(groundMesh);

/* ─── Player character ─── */
const playerGroup = new THREE.Group();

const _bodyMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(PLAYER_R, PLAYER_R * 0.85, PLAYER_H * 0.65, 18),
    new THREE.MeshStandardMaterial({ color: 0xff6584 })
);
_bodyMesh.position.y = PLAYER_H * 0.32;
_bodyMesh.castShadow = true;

const _headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(PLAYER_R * 1.1, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xffd6e0 })
);
_headMesh.position.y = PLAYER_H * 0.82;
_headMesh.castShadow = true;

// eyes
[-0.09, 0.09].forEach(x => {
    const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    eye.position.set(x, PLAYER_H * 0.86, PLAYER_R * 1.0);
    playerGroup.add(eye);
});

playerGroup.add(_bodyMesh, _headMesh);
playerGroup.visible = false;
scene.add(playerGroup);

/* ════════════════════════════════════════════
   Geometry factories
   ════════════════════════════════════════════ */
function makePart(type, color, opacity = 1) {
    let geo;
    const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.5,
        metalness: 0.15,
        transparent: opacity < 1,
        opacity: opacity,
    });

    switch (type) {
        case 'board': {
            geo = new THREE.BoxGeometry(3, 0.18, 4);
            break;
        }
        case 'hemisphere': {
            geo = new THREE.SphereGeometry(1.4, 36, 18, 0, Math.PI * 2, 0, Math.PI / 2);
            break;
        }
        case 'triangle': {
            // Triangular prism via ExtrudeGeometry
            const sh = new THREE.Shape();
            sh.moveTo(-1.4, 0); sh.lineTo(1.4, 0); sh.lineTo(0, 2); sh.closePath();
            geo = new THREE.ExtrudeGeometry(sh, { depth: 3, bevelEnabled: false });
            geo.translate(0, 0, -1.5);
            break;
        }
        case 'column': {
            geo = new THREE.CylinderGeometry(0.7, 0.7, 3.5, 28);
            break;
        }
        case 'sphere': {
            geo = new THREE.SphereGeometry(1.2, 36, 28);
            break;
        }
        case 'box': {
            geo = new THREE.BoxGeometry(2.2, 2.2, 2.2);
            break;
        }
        default:
            geo = new THREE.BoxGeometry(1, 1, 1);
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partType = type;
    return mesh;
}

/* ════════════════════════════════════════════
   Draw-mode helpers
   ════════════════════════════════════════════ */
const raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();

function placePart(point) {
    const mesh = makePart(selectedPart, currentColor, currentOpacity);
    mesh.position.copy(point);
    // Lift so bottom sits on surface
    const box = new THREE.Box3().setFromObject(mesh);
    mesh.position.y += -box.min.y + point.y;
    scene.add(mesh);
    sceneObjects.push(mesh);
    undoStack.push({ act: 'add', mesh });
    selectObj(mesh);
}

function selectObj(obj) {
    if (obj === selectedObj) return;
    if (selectedObj) {
        selectedObj.material.emissive?.set(0x000000);
        tfCtrl.detach();
    }
    selectedObj = obj;
    if (obj) {
        if (!obj.material.emissive) obj.material.emissive = new THREE.Color();
        obj.material.emissive.set(0x1a1a44);
        tfCtrl.attach(obj);
        tfCtrl.setMode(tMode);
        document.getElementById('color-picker').value =
            '#' + obj.material.color.getHexString();
    }
}

function deleteSelected() {
    if (!selectedObj) return;
    scene.remove(selectedObj);
    sceneObjects = sceneObjects.filter(o => o !== selectedObj);
    undoStack.push({ act: 'remove', mesh: selectedObj });
    tfCtrl.detach();
    selectedObj = null;
}

function undo() {
    const last = undoStack.pop();
    if (!last) return;
    if (last.act === 'add') {
        scene.remove(last.mesh);
        sceneObjects = sceneObjects.filter(o => o !== last.mesh);
        if (selectedObj === last.mesh) { tfCtrl.detach(); selectedObj = null; }
    } else if (last.act === 'remove') {
        scene.add(last.mesh);
        sceneObjects.push(last.mesh);
    } else if (last.act === 'csg') {
        // Revert CSG: remove the modified mesh, restore the original
        scene.remove(last.newMesh);
        sceneObjects = sceneObjects.filter(o => o !== last.newMesh);
        if (selectedObj === last.newMesh) { tfCtrl.detach(); selectedObj = null; }

        scene.add(last.oldMesh);
        sceneObjects.push(last.oldMesh);
    }
}

/* ─── Canvas click (draw mode) ─── */
canvas.addEventListener('pointerdown', e => {
    if (mode !== 'draw' || tfCtrl.dragging || holeTransform.dragging) return;
    // Hole mode: interaction is fully handled by holeTransform (drag handles)
    if (holeMode) return;

    const rect = canvas.getBoundingClientRect();
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(_mouse, drawCamera);

    const hits = raycaster.intersectObjects([groundMesh, ...sceneObjects], false);
    if (!hits.length) { selectObj(null); return; }

    const hit = hits[0];
    if (placingMode) {
        placePart(hit.point.clone().setY(hit.point.y > 0.01 ? hit.point.y : 0));
    } else {
        selectObj(hit.object.name === '__ground__' ? null : hit.object);
    }
});

/* ─── Cut Hole (CSG) — uses ghost position + scale ─── */
function cutHole(targetMesh, holePos, holeScale) {
    // Target brush in world space
    const targetBrush = new Brush(targetMesh.geometry);
    targetBrush.position.copy(targetMesh.position);
    targetBrush.rotation.copy(targetMesh.rotation);
    targetBrush.scale.copy(targetMesh.scale);
    targetBrush.updateMatrixWorld();

    // Hole brush: unit geometry at ghost position & scale
    const holeGeo = makeHoleGeo(holeMode);
    const holeBrush = new Brush(holeGeo);
    holeBrush.position.copy(holePos);
    holeBrush.scale.copy(holeScale);
    holeBrush.updateMatrixWorld();

    let resultMesh;
    try {
        resultMesh = csgEvaluator.evaluate(targetBrush, holeBrush, SUBTRACTION);
    } catch (err) {
        console.error('CSG failed:', err);
        return false;
    }

    const newMesh = new THREE.Mesh(resultMesh.geometry, targetMesh.material.clone());
    newMesh.castShadow = true;
    newMesh.receiveShadow = true;
    newMesh.userData = { ...targetMesh.userData, csgMesh: true };
    newMesh.position.set(0, 0, 0);
    newMesh.rotation.set(0, 0, 0);
    newMesh.scale.set(1, 1, 1);

    scene.remove(targetMesh);
    sceneObjects = sceneObjects.filter(o => o !== targetMesh);
    scene.add(newMesh);
    sceneObjects.push(newMesh);

    if (selectedObj === targetMesh) { tfCtrl.detach(); selectedObj = null; }

    undoStack.push({ act: 'csg', oldMesh: targetMesh, newMesh });
    return true;
}

/* ─── Confirm Hole (Enter キー) ─── */
function confirmHole() {
    if (!ghostMesh || !holeMode) return;

    // Find all scene objects whose bounding box overlaps the ghost
    const ghostBox = new THREE.Box3().setFromObject(ghostMesh);
    const targets = sceneObjects.filter(o =>
        ghostBox.intersectsBox(new THREE.Box3().setFromObject(o))
    );

    if (targets.length === 0) {
        showToast('⚠ 部材に重なっていません');
        return;
    }

    // Snapshot ghost transform before removing it
    const holePos = ghostMesh.position.clone();
    const holeScale = ghostMesh.scale.clone();

    holeTransform.detach();
    scene.remove(ghostMesh);
    ghostMesh.geometry.dispose();
    ghostMesh = null;

    let ok = 0;
    for (const target of targets) {
        if (cutHole(target, holePos, holeScale)) ok++;
    }

    if (ok > 0) showToast('🕳️ 穴をあけました');
    else showToast('⚠ 穴あけに失敗しました');
}

/* ════════════════════════════════════════════
   UI wiring
   ════════════════════════════════════════════ */

// Part palette
document.querySelectorAll('.part-btn:not(.hole-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
        if (holeMode) cancelHoleMode();
        selectedPart = btn.dataset.part;
        placingMode = true;
        holeMode = null;
        document.querySelectorAll('.part-btn, .tool-btn[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// Hole palette
document.querySelectorAll('.hole-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        holeMode = btn.dataset.hole;
        placingMode = false;
        document.querySelectorAll('.part-btn, .tool-btn[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (selectedObj) {
            tfCtrl.detach();
            selectedObj.material.emissive?.set(0x000000);
            selectedObj = null;
        }
        showGhost();
    });
});

// Hole transform mode buttons
document.getElementById('hole-btn-translate')?.addEventListener('click', () => {
    holeTMode = 'translate';
    if (ghostMesh) holeTransform.setMode('translate');
    updateHoleModeBtns();
});

document.getElementById('hole-btn-scale')?.addEventListener('click', () => {
    holeTMode = 'scale';
    if (ghostMesh) holeTransform.setMode('scale');
    updateHoleModeBtns();
});

// Transform tools (for parts)
document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
        tMode = btn.dataset.mode;
        placingMode = false;
        if (holeMode) cancelHoleMode();
        document.querySelectorAll('.tool-btn[data-mode], .part-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (selectedObj) tfCtrl.setMode(tMode);
    });
});

// Color
document.getElementById('color-picker').addEventListener('input', e => {
    currentColor = e.target.value;
    if (selectedObj) selectedObj.material.color.set(currentColor);
});

// Preset Colors
let currentOpacity = 1.0; // 現在選択中の不透明度

// 半透明スウォッチの背景を JS で組み立てる（--pc CSS変数はrgba()と直接使えないため）
document.querySelectorAll('.preset-color--alpha').forEach(sw => {
    const hex = sw.dataset.color;
    // hex → rgb 変換
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    sw.style.background = `
        linear-gradient(rgba(${r},${g},${b},0.38), rgba(${r},${g},${b},0.38)),
        repeating-conic-gradient(#555 0% 25%, #888 0% 50%) 0 0 / 8px 8px
    `;
});

document.querySelectorAll('.preset-color').forEach(btn => {
    btn.addEventListener('click', () => {
        currentColor = btn.dataset.color;
        currentOpacity = parseFloat(btn.dataset.opacity ?? '1');
        document.getElementById('color-picker').value = currentColor;
        if (selectedObj) {
            selectedObj.material.color.set(currentColor);
            selectedObj.material.transparent = currentOpacity < 1;
            selectedObj.material.opacity = currentOpacity;
            selectedObj.material.needsUpdate = true;
        }
    });
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (mode === 'play') {
        // ゲーム中はブラウザのデフォルト動作（スペース=ボタンクリック、矢印=スクロール）を抑止
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code))
            e.preventDefault();
        return;
    }
    // 穴あけモード: Enter で確定、ESC でキャンセル
    if (holeMode) {
        if (e.key === 'Enter') { e.preventDefault(); confirmHole(); return; }
        if (e.code === 'Escape') { cancelHoleMode(); return; }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-undo').addEventListener('click', undo);

document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('シーンをクリアしますか？')) return;
    if (holeMode) cancelHoleMode();
    sceneObjects.forEach(m => scene.remove(m));
    sceneObjects = []; undoStack = [];
    tfCtrl.detach(); selectedObj = null;
});

/* ─── Save / Load (.json file) ─── */
document.getElementById('btn-save').addEventListener('click', () => {
    if (sceneObjects.length === 0) {
        showToast('⚠ 保存する部材がありません');
        return;
    }
    const data = sceneObjects.map(m => {
        const base = {
            type: m.userData.partType,
            color: '#' + m.material.color.getHexString(),
            opacity: m.material.opacity ?? 1,
            pos: m.position.toArray(),
            rot: [m.rotation.x, m.rotation.y, m.rotation.z],
            scl: m.scale.toArray(),
        };
        // CSG-modified meshes have world positions baked in; save the vertex buffer
        if (m.userData.csgMesh) {
            const posAttr = m.geometry.getAttribute('position');
            base.csgVertices = Array.from(posAttr.array);
        }
        return base;
    });

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'my_3d_work.json'; a.click();
    URL.revokeObjectURL(url);
    showToast('💾 ファイルをダウンロードしました');
});

const fileInput = document.getElementById('file-input');
document.getElementById('btn-load').addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            if (holeMode) cancelHoleMode();
            sceneObjects.forEach(m => scene.remove(m));
            sceneObjects = []; undoStack = []; tfCtrl.detach(); selectedObj = null;

            data.forEach(d => {
                let m;
                if (d.csgVertices) {
                    // Reconstruct CSG mesh from raw vertex buffer
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position',
                        new THREE.BufferAttribute(new Float32Array(d.csgVertices), 3));
                    geo.computeVertexNormals();
                    const mat = new THREE.MeshStandardMaterial({
                        color: new THREE.Color(d.color),
                        roughness: 0.5,
                        metalness: 0.15,
                        transparent: (d.opacity ?? 1) < 1,
                        opacity: d.opacity ?? 1,
                    });
                    m = new THREE.Mesh(geo, mat);
                    m.userData = { partType: d.type, csgMesh: true };
                    m.castShadow = true;
                    m.receiveShadow = true;
                    // CSG meshes already have world coords baked in
                    m.position.set(0, 0, 0);
                    m.rotation.set(0, 0, 0);
                    m.scale.set(1, 1, 1);
                } else {
                    m = makePart(d.type, d.color, d.opacity ?? 1);
                    m.position.fromArray(d.pos);
                    m.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
                    m.scale.fromArray(d.scl);
                }
                scene.add(m); sceneObjects.push(m);
            });
            showToast('📂 ファイルを読み込みました！');
        } catch (err) {
            console.error(err);
            showToast('❌ ファイルの読み込みに失敗しました');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(showToast._tid);
    showToast._tid = setTimeout(() => { t.style.opacity = '0'; }, 2000);
}

/* ════════════════════════════════════════════
   Game mode
   ════════════════════════════════════════════ */
document.getElementById('btn-play').addEventListener('click', enterGame);
document.getElementById('btn-exit').addEventListener('click', exitGame);

function enterGame() {
    if (holeMode) cancelHoleMode();
    mode = 'play';
    document.getElementById('side-panel').style.display = 'none';
    document.getElementById('game-hud').classList.add('active');
    orbit.enabled = false;
    tfCtrl.detach();
    if (selectedObj) { selectedObj.material.emissive?.set(0x000000); selectedObj = null; }
    // ★ フォーカスを外す: Spaceキーがボタンを再クリックするバグを防ぐ
    document.activeElement?.blur();

    // Spawn
    let sy = 2.5;
    if (sceneObjects.length) {
        const bb = new THREE.Box3();
        sceneObjects.forEach(o => bb.expandByObject(o));
        const c = new THREE.Vector3(); bb.getCenter(c);
        sy = bb.max.y + 2;
        playerGroup.position.set(c.x, sy, c.z + 3);
    } else {
        playerGroup.position.set(0, sy, 0);
    }
    playerGroup.visible = false;  // 一人称なので体は非表示
    player.vel.set(0, 0, 0);
    player.yaw = 0; player.pitch = 0;

    canvas.requestPointerLock();
}

function exitGame() {
    mode = 'draw';
    document.getElementById('side-panel').style.display = '';
    document.getElementById('game-hud').classList.remove('active');
    orbit.enabled = true;
    document.exitPointerLock?.();
}

document.addEventListener('keydown', e => {
    if (e.code === 'Escape' && mode === 'play') exitGame();
});

// Mouse look
document.addEventListener('mousemove', e => {
    if (mode !== 'play' || !document.pointerLockElement) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    player.pitch = Math.max(-Math.PI * 0.38, Math.min(Math.PI * 0.38, player.pitch));
});

/* ─── Raycast-based Collision (respects CSG holes) ─── */
const _colRay = new THREE.Raycaster();
_colRay.firstHitOnly = true;
const _VEC_DOWN = new THREE.Vector3(0, -1, 0);
const _VEC_UP = new THREE.Vector3(0, 1, 0);

function resolveCollisions(pos, vel) {
    const r = PLAYER_R;
    const h = player.isCrouching ? PLAYER_H_CROUCH : PLAYER_H;
    player.onGround = false;
    player.groundNormal.set(0, 1, 0);

    // 地面 (y=0 の床)
    if (pos.y <= 0.001) {
        pos.y = 0;
        vel.y = Math.max(vel.y, 0);
        player.onGround = true;
    }
    if (!sceneObjects.length) return;

    // ── 床: 足元から下向きレイ ──
    _colRay.set(new THREE.Vector3(pos.x, pos.y + 0.15, pos.z), _VEC_DOWN);
    const floorHits = _colRay.intersectObjects(sceneObjects, false)
        .filter(hit => hit.distance <= 0.3);
    if (floorHits.length && vel.y <= 0) {
        pos.y = floorHits[0].point.y;
        vel.y = 0;
        player.onGround = true;
        // 面の法線を記録（傾き検知に使用）
        if (floorHits[0].face) {
            const n = floorHits[0].face.normal.clone();
            n.applyQuaternion(floorHits[0].object.quaternion).normalize();
            player.groundNormal.copy(n);
        }
    }

    // ── 天井: 頭上から上向きレイ ──
    _colRay.set(new THREE.Vector3(pos.x, pos.y + h - 0.05, pos.z), _VEC_UP);
    const ceilHits = _colRay.intersectObjects(sceneObjects, false)
        .filter(hit => hit.distance <= 0.2);
    if (ceilHits.length && vel.y > 0) vel.y = 0;

    // ── 壁: 4方向 × 3高さ の水平レイ ──
    // 穴の部分ではレイが貫通するので当たり数が減り、押し返しが抑制される。
    const wHeights = [pos.y + 0.2, pos.y + h * 0.45, pos.y + h * 0.85];
    const wDirs = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, -1),
    ];
    for (const dir of wDirs) {
        let hitCount = 0;
        let minDist = Infinity;
        let hitNormalY = 1;
        for (const wy of wHeights) {
            _colRay.set(new THREE.Vector3(pos.x, wy, pos.z), dir);
            const wallHits = _colRay.intersectObjects(sceneObjects, false)
                .filter(hit => hit.distance < r + 0.04);
            if (wallHits.length) {
                hitCount++;
                if (wallHits[0].distance < minDist) {
                    minDist = wallHits[0].distance;
                    // 壁の法線Y成分を取得（急すぎる壁は垂直速度をカット）
                    if (wallHits[0].face) {
                        const wn = wallHits[0].face.normal.clone();
                        wn.applyQuaternion(wallHits[0].object.quaternion);
                        hitNormalY = Math.abs(wn.y);
                    }
                }
            }
        }
        if (hitCount >= 2) {
            const push = r + 0.04 - minDist;
            pos.x -= dir.x * push;
            pos.z -= dir.z * push;
            // 法線Yが SLOPE_LIMIT 以上 ＝「ほぼ水平な面」→ 壁として上昇をカット
            // 急な壁(hitNormalY < SLOPE_LIMIT)は垂直成分も抑える
            if (hitNormalY < SLOPE_LIMIT && vel.y > 0) {
                vel.y *= hitNormalY; // 急な壁への衝突で上昇速度を大幅減衰
            }
        }
    }
}


/* ─── Game tick (一人称・マインクラフト式) ─── */
// しゃがみへの立ち上がり確認: 頭上に空間があるか?
function canStandUp(pos) {
    const checkH = PLAYER_H - PLAYER_H_CROUCH; // 増える高さ分チェック
    _colRay.set(
        new THREE.Vector3(pos.x, pos.y + PLAYER_H_CROUCH, pos.z),
        _VEC_UP
    );
    const hits = _colRay.intersectObjects(sceneObjects, false)
        .filter(h => h.distance < checkH + 0.1);
    // 地面(y=0)は天井扱いしない
    return hits.length === 0;
}

function tickGame(dt) {
    const pos = playerGroup.position;

    // ── しゃがみ判定 ──
    const wantCrouch = !!keys['ShiftLeft'] || !!keys['ShiftRight'];
    if (wantCrouch) {
        player.isCrouching = true;
    } else if (player.isCrouching) {
        // 立ち上がる前に頭上チェック
        if (canStandUp(pos)) player.isCrouching = false;
    }

    // ── 坂道スライド判定 ──
    // groundNormal.y が SLOPE_LIMIT 未満 = 45度以上の坂 → しゃがみ中はスライド
    const slopeY = player.groundNormal.y;
    const onSlope = player.onGround && slopeY < SLOPE_LIMIT && slopeY > 0.1;
    player.isSliding = player.isCrouching && onSlope;

    // ── HUD 更新 ──
    const hudSlide = document.getElementById('hud-slide');
    if (hudSlide) {
        hudSlide.style.display = player.isCrouching
            ? (player.isSliding ? 'block' : 'block')
            : 'none';
        hudSlide.textContent = player.isSliding ? '🏂 スライディング!' : '🦆 しゃがみ中';
    }

    // 移動方向: yaw だけで水平方向を決定（上を向いても上昇しない）
    const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const dir = new THREE.Vector3();
    if (keys['KeyW'] || keys['ArrowUp']) dir.addScaledVector(forward, 1);
    if (keys['KeyS'] || keys['ArrowDown']) dir.addScaledVector(forward, -1);
    if (keys['KeyA'] || keys['ArrowLeft']) dir.addScaledVector(right, -1);
    if (keys['KeyD'] || keys['ArrowRight']) dir.addScaledVector(right, 1);
    if (dir.lengthSq() > 0) dir.normalize();

    // ── 速度計算 ──
    if (player.isSliding) {
        // スライディング中: WASD 操作を無効にして坂の重力成分だけ加速
        // 滑走方向 = 重力ベクトル - (重力⋅法線)×法線  (坂面への投影)
        const gravVec = new THREE.Vector3(0, GRAVITY * dt, 0);
        const dot = gravVec.dot(player.groundNormal);
        const slideAcc = gravVec.clone().addScaledVector(player.groundNormal, -dot);
        player.vel.x += slideAcc.x;
        player.vel.z += slideAcc.z;
        player.vel.y += GRAVITY * dt;

        // 空気抵抗(終端速度収束) ← 弱めて加速しやすく
        player.vel.x *= 0.998;
        player.vel.z *= 0.998;

        // 速度リミット (水平成分)
        const hSpd = Math.sqrt(player.vel.x ** 2 + player.vel.z ** 2);
        if (hSpd > SLIDE_MAX_SPD) {
            const ratio = SLIDE_MAX_SPD / hSpd;
            player.vel.x *= ratio;
            player.vel.z *= ratio;
        }
    } else {
        // 通常移動: しゃがみ中はスピードを半分に
        const spd = player.isCrouching ? MOVE_SPD * 0.5 : MOVE_SPD;
        player.vel.x = dir.x * spd;
        player.vel.z = dir.z * spd;
        player.vel.y += GRAVITY * dt;
    }

    // ジャンプ (しゃがみ中は不可)
    if (keys['Space'] && player.onGround && !player.isCrouching) {
        player.vel.y = JUMP_VEL;
        player.onGround = false;
    }

    pos.x += player.vel.x * dt;
    pos.y += player.vel.y * dt;
    pos.z += player.vel.z * dt;

    // 落下しすぎたらリスポーン
    if (pos.y < -30) {
        pos.y = 5;
        player.vel.set(0, 0, 0);
        player.isCrouching = false;
        player.isSliding = false;
    }

    resolveCollisions(pos, player.vel);

    // ─── 一人称カメラ: 目の高さに配置してyaw/pitch で回転 ───
    const curH = player.isCrouching ? PLAYER_H_CROUCH : PLAYER_H;
    const eyeY = pos.y + curH * 0.88;
    gameCamera.position.set(pos.x, eyeY, pos.z);
    // Euler順序 YXZ がFPS的な回転に最適
    gameCamera.rotation.order = 'YXZ';
    gameCamera.rotation.y = player.yaw;
    gameCamera.rotation.x = player.pitch;
}

/* ════════════════════════════════════════════
   Resize + render loop
   ════════════════════════════════════════════ */
function onResize() {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    [drawCamera, gameCamera].forEach(c => { c.aspect = w / h; c.updateProjectionMatrix(); });
}
window.addEventListener('resize', onResize);
onResize();

const clock = new THREE.Clock();

/* ─── WASD カメラ移動 (お絵描きモード) ─── */
const _camRight = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _camDelta = new THREE.Vector3();

function tickDrawCamera(dt) {
    // 入力フォーカス中は動かさない
    if (document.activeElement?.matches('input, textarea, select')) return;

    const speed = 12 * dt;
    drawCamera.getWorldDirection(_camForward);
    _camForward.y = 0;
    if (_camForward.lengthSq() < 0.0001) return;
    _camForward.normalize();
    _camRight.crossVectors(_camForward, new THREE.Vector3(0, 1, 0)).normalize();

    _camDelta.set(0, 0, 0);
    if (keys['KeyW']) _camDelta.addScaledVector(_camForward, speed);
    if (keys['KeyS']) _camDelta.addScaledVector(_camForward, -speed);
    if (keys['KeyA']) _camDelta.addScaledVector(_camRight, -speed);
    if (keys['KeyD']) _camDelta.addScaledVector(_camRight, speed);

    if (_camDelta.lengthSq() > 0) {
        drawCamera.position.add(_camDelta);
        orbit.target.add(_camDelta);
    }
}

(function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (mode === 'draw') { tickDrawCamera(dt); orbit.update(); renderer.render(scene, drawCamera); }
    else { tickGame(dt); renderer.render(scene, gameCamera); }
})();
