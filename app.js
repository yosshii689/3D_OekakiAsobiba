// ========================================================
// 3D お絵描き遊び場  +  ちびっこ探検ゲーム
// Three.js r160  (import-map via CDN)
// ========================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';

/* ─── Physics constants ─── */
const GRAVITY = -20;
const JUMP_VEL = 9;
const MOVE_SPD = 6;
const PLAYER_H = 0.9;   // capsule height
const PLAYER_R = 0.32;  // capsule radius

/* ─── App state ─── */
let mode = 'draw'; // 'draw' | 'play'
let selectedPart = 'board';
let selectedObj = null;
let tMode = 'translate';
let sceneObjects = [];
let currentColor = '#6c63ff';
let undoStack = [];
let placingMode = false;
let holeMode = null;   // 'box' | 'hemisphere' | 'sphere' | null
const csgEvaluator = new Evaluator();
csgEvaluator.attributes = ['position', 'normal'];

/* ─── Ghost (preview) mesh for hole tool ─── */
let ghostMesh = null;   // semi-transparent preview mesh

function getHoleSizes() {
    return {
        sx: parseFloat(document.getElementById('hole-sx').value),
        sy: parseFloat(document.getElementById('hole-sy').value),
        sz: parseFloat(document.getElementById('hole-sz').value),
    };
}

function makeHoleGeo(mode, sx, sy, sz) {
    let geo;
    if (mode === 'box') {
        geo = new THREE.BoxGeometry(sx, sy, sz);
    } else if (mode === 'hemisphere') {
        // LatheGeometry で頂点を共有した完全水密の半球を生成
        // ドームのプロファイル: 北極 (0, 0.5) → 赤道 (0.5, 0) → 底面中心 (0, 0)
        const N = 16;
        const pts = [];
        for (let i = 0; i <= N; i++) {
            const phi = (i / N) * (Math.PI / 2);
            pts.push(new THREE.Vector2(Math.sin(phi) * 0.5, Math.cos(phi) * 0.5));
        }
        pts.push(new THREE.Vector2(0, 0)); // 底面の中心で閉じる
        geo = new THREE.LatheGeometry(pts, 32);
    } else {
        geo = new THREE.SphereGeometry(0.5, 32, 16);
    }
    return geo;
}

function getHoleScale(mode, sx, sy, sz) {
    // Box: dimensions are already baked. Sphere/Hemi: scale unit sphere.
    if (mode === 'box') return new THREE.Vector3(1, 1, 1);
    return new THREE.Vector3(sx, sy, sz);
}

function updateGhostGeo() {
    if (!ghostMesh) return;
    const { sx, sy, sz } = getHoleSizes();
    ghostMesh.geometry.dispose();
    ghostMesh.geometry = makeHoleGeo(holeMode, sx, sy, sz);
    const s = getHoleScale(holeMode, sx, sy, sz);
    ghostMesh.scale.copy(s);
}

function showGhost() {
    if (ghostMesh) {
        scene.remove(ghostMesh);
        ghostMesh.geometry.dispose();
        ghostMesh = null;
    }
    if (!holeMode) return;
    const { sx, sy, sz } = getHoleSizes();
    const geo = makeHoleGeo(holeMode, sx, sy, sz);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xff4444,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        wireframe: false,
    });
    ghostMesh = new THREE.Mesh(geo, mat);
    const s = getHoleScale(holeMode, sx, sy, sz);
    ghostMesh.scale.copy(s);
    ghostMesh.visible = false;  // hidden until mouse hits something
    scene.add(ghostMesh);
}

function hideGhost() {
    if (ghostMesh) ghostMesh.visible = false;
}

/* ─── Player state ─── */
const player = { vel: new THREE.Vector3(), onGround: false, yaw: 0, pitch: 0 };
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

/* ─── Cameras ─── */
const drawCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
drawCamera.position.set(8, 8, 12);

const gameCamera = new THREE.PerspectiveCamera(75, 1, 0.05, 300);

/* ─── Orbit + Transform controls ─── */
const orbit = new OrbitControls(drawCamera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 1;
orbit.maxDistance = 120;

const tfCtrl = new TransformControls(drawCamera, renderer.domElement);
tfCtrl.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
scene.add(tfCtrl);

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
function makePart(type, color) {
    let geo;
    const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        roughness: 0.5,
        metalness: 0.15,
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
    const mesh = makePart(selectedPart, currentColor);
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

/* ─── Canvas events ─── */
canvas.addEventListener('pointermove', e => {
    if (mode !== 'draw' || !holeMode || !ghostMesh) return;
    const rect = canvas.getBoundingClientRect();
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(_mouse, drawCamera);
    const hits = raycaster.intersectObjects(sceneObjects, false);
    if (hits.length) {
        ghostMesh.position.copy(hits[0].point);
        ghostMesh.visible = true;
    } else {
        ghostMesh.visible = false;
    }
});

canvas.addEventListener('pointerleave', () => { hideGhost(); });

canvas.addEventListener('pointerdown', e => {
    if (mode !== 'draw' || tfCtrl.dragging) return;
    const rect = canvas.getBoundingClientRect();
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(_mouse, drawCamera);

    const hits = raycaster.intersectObjects([groundMesh, ...sceneObjects], false);
    if (!hits.length) { selectObj(null); return; }

    const hit = hits[0];

    if (holeMode && hit.object !== groundMesh) {
        cutHole(hit.object, hit.point);
    } else if (placingMode) {
        placePart(hit.point.clone().setY(hit.point.y > 0.01 ? hit.point.y : 0));
    } else {
        selectObj(hit.object.name === '__ground__' ? null : hit.object);
    }
});

/* ─── Cut Hole (CSG) ─── */
function cutHole(targetMesh, hitPoint) {
    const { sx, sy, sz } = getHoleSizes();

    // Target brush in world space
    const targetBrush = new Brush(targetMesh.geometry);
    targetBrush.position.copy(targetMesh.position);
    targetBrush.rotation.copy(targetMesh.rotation);
    targetBrush.scale.copy(targetMesh.scale);
    targetBrush.updateMatrixWorld();

    // Hole brush: unit geometry scaled to sx/sy/sz at hit point
    const holeGeo = makeHoleGeo(holeMode, sx, sy, sz);
    const holeBrush = new Brush(holeGeo);
    holeBrush.position.copy(hitPoint);
    const hs = getHoleScale(holeMode, sx, sy, sz);
    holeBrush.scale.copy(hs);
    holeBrush.updateMatrixWorld();

    // CSG subtraction
    let resultMesh;
    try {
        resultMesh = csgEvaluator.evaluate(targetBrush, holeBrush, SUBTRACTION);
    } catch (err) {
        console.error('CSG failed:', err);
        showToast('⚠ 穴あけに失敗しました');
        return;
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
    showToast('🕳️ 穴をあけました');
}

/* ════════════════════════════════════════════
   UI wiring
   ════════════════════════════════════════════ */

// Part palette
document.querySelectorAll('.part-btn:not(.hole-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
        selectedPart = btn.dataset.part;
        placingMode = true;
        holeMode = null;
        hideGhost();
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
        showGhost(); // create/refresh ghost mesh for current hole type
    });
});

// XYZ sliders — update ghost geometry live
['hole-sx', 'hole-sy', 'hole-sz'].forEach(id => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    el.addEventListener('input', () => {
        valEl.textContent = parseFloat(el.value).toFixed(1);
        updateGhostGeo();
    });
});

// Transform tools
document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
        tMode = btn.dataset.mode;
        placingMode = false;
        holeMode = null;
        hideGhost();
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
document.querySelectorAll('.preset-color').forEach(btn => {
    btn.addEventListener('click', () => {
        currentColor = btn.dataset.color;
        document.getElementById('color-picker').value = currentColor;
        if (selectedObj) selectedObj.material.color.set(currentColor);
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
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-undo').addEventListener('click', undo);

document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('シーンをクリアしますか？')) return;
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
                    m = makePart(d.type, d.color);
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
    const r = PLAYER_R, h = PLAYER_H;
    player.onGround = false;

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
        .filter(hit => hit.distance <= 0.25);
    if (floorHits.length && vel.y <= 0) {
        pos.y = floorHits[0].point.y;
        vel.y = 0;
        player.onGround = true;
    }

    // ── 天井: 頭上から上向きレイ ──
    _colRay.set(new THREE.Vector3(pos.x, pos.y + h - 0.05, pos.z), _VEC_UP);
    const ceilHits = _colRay.intersectObjects(sceneObjects, false)
        .filter(hit => hit.distance <= 0.2);
    if (ceilHits.length && vel.y > 0) vel.y = 0;

    // ── 壁: 4方向 × 3高さ の水平レイ ──
    // 3サンプル中 2つ以上が壁に当たった方向だけ押し返す。
    // 穴の部分ではレイが貫通するので当たり数が減り、押し返しが抑制される。
    const wHeights = [pos.y + 0.2, pos.y + h * 0.45, pos.y + h * 0.8];
    const wDirs = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, -1),
    ];
    for (const dir of wDirs) {
        let hitCount = 0;
        let minDist = Infinity;
        for (const wy of wHeights) {
            _colRay.set(new THREE.Vector3(pos.x, wy, pos.z), dir);
            const wallHits = _colRay.intersectObjects(sceneObjects, false)
                .filter(hit => hit.distance < r + 0.04);
            if (wallHits.length) {
                hitCount++;
                minDist = Math.min(minDist, wallHits[0].distance);
            }
        }
        // 穴がある = 一部のレイが通り抜け → hitCount < 2 なら押し返さない
        if (hitCount >= 2) {
            const push = r + 0.04 - minDist;
            pos.x -= dir.x * push;
            pos.z -= dir.z * push;
        }
    }
}


/* ─── Game tick (一人称・マインクラフト式) ─── */
function tickGame(dt) {
    const pos = playerGroup.position;

    // 移動方向: yaw だけで水平方向を決定（上を向いても上昇しない）
    const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    const dir = new THREE.Vector3();
    if (keys['KeyW'] || keys['ArrowUp']) dir.addScaledVector(forward, 1);
    if (keys['KeyS'] || keys['ArrowDown']) dir.addScaledVector(forward, -1);
    if (keys['KeyA'] || keys['ArrowLeft']) dir.addScaledVector(right, -1);
    if (keys['KeyD'] || keys['ArrowRight']) dir.addScaledVector(right, 1);
    if (dir.lengthSq() > 0) dir.normalize();

    player.vel.x = dir.x * MOVE_SPD;
    player.vel.z = dir.z * MOVE_SPD;
    player.vel.y += GRAVITY * dt;

    if (keys['Space'] && player.onGround) {
        player.vel.y = JUMP_VEL;
        player.onGround = false;
    }

    pos.x += player.vel.x * dt;
    pos.y += player.vel.y * dt;
    pos.z += player.vel.z * dt;

    // 落下しすぎたらリスポーン
    if (pos.y < -30) { pos.y = 5; player.vel.set(0, 0, 0); }

    resolveCollisions(pos, player.vel);

    // ─── 一人称カメラ: 目の高さに配置してyaw/pitch で回転 ───
    const eyeY = pos.y + PLAYER_H * 0.88;
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
(function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (mode === 'draw') { orbit.update(); renderer.render(scene, drawCamera); }
    else { tickGame(dt); renderer.render(scene, gameCamera); }
})();
