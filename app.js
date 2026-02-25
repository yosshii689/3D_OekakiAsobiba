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

/* ─── Canvas click ─── */
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
    const size = parseFloat(document.getElementById('hole-size').value);

    // Create the brush for the target object
    const targetBrush = new Brush(targetMesh.geometry);
    targetBrush.position.copy(targetMesh.position);
    targetBrush.rotation.copy(targetMesh.rotation);
    targetBrush.scale.copy(targetMesh.scale);
    targetBrush.updateMatrixWorld();

    // Create the brush for the hole
    let holeGeo;
    if (holeMode === 'box') {
        holeGeo = new THREE.BoxGeometry(size, size, size);
    } else if (holeMode === 'hemisphere') {
        holeGeo = new THREE.SphereGeometry(size / 2, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    } else {
        holeGeo = new THREE.SphereGeometry(size / 2, 32, 16);
    }
    const holeBrush = new Brush(holeGeo);
    holeBrush.position.copy(hitPoint);
    holeBrush.updateMatrixWorld();

    // Perform CSG subtraction
    let resultMesh;
    try {
        resultMesh = csgEvaluator.evaluate(targetBrush, holeBrush, SUBTRACTION);
    } catch (err) {
        console.error("CSG failed:", err);
        showToast("⚠ 穴あけに失敗しました");
        return;
    }

    // Preserve original material and userData
    // three-bvh-csg creates groups if multiple materials are involved, but we only have 1
    const newMesh = new THREE.Mesh(resultMesh.geometry, targetMesh.material.clone());
    newMesh.castShadow = true;
    newMesh.receiveShadow = true;
    newMesh.userData = { ...targetMesh.userData, csgMesh: true };
    // result mesh from CSG is always centered at origin with world coordinates baked in
    newMesh.position.set(0, 0, 0);
    newMesh.rotation.set(0, 0, 0);
    newMesh.scale.set(1, 1, 1);

    // Swap old with new
    scene.remove(targetMesh);
    sceneObjects = sceneObjects.filter(o => o !== targetMesh);

    scene.add(newMesh);
    sceneObjects.push(newMesh);

    if (selectedObj === targetMesh) {
        tfCtrl.detach();
        selectedObj = null;
    }

    undoStack.push({ act: 'csg', oldMesh: targetMesh, newMesh: newMesh });
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
    });
});

// Transform tools
document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
        tMode = btn.dataset.mode;
        placingMode = false;
        holeMode = null;
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

/* ─── Collision ─── */
const _aabb = new THREE.Box3();
const _pBox = new THREE.Box3();

function resolveCollisions(pos, vel) {
    const r = PLAYER_R, h = PLAYER_H;

    // 地面
    player.onGround = false;
    if (pos.y < 0) { pos.y = 0; vel.y = Math.max(vel.y, 0); player.onGround = true; }

    for (const obj of sceneObjects) {
        _aabb.setFromObject(obj);
        _pBox.min.set(pos.x - r, pos.y, pos.z - r);
        _pBox.max.set(pos.x + r, pos.y + h, pos.z + r);
        if (!_pBox.intersectsBox(_aabb)) continue;

        // 各軸のめり込み量
        const dx1 = _pBox.max.x - _aabb.min.x, dx2 = _aabb.max.x - _pBox.min.x;
        const dy1 = _pBox.max.y - _aabb.min.y, dy2 = _aabb.max.y - _pBox.min.y;
        const dz1 = _pBox.max.z - _aabb.min.z, dz2 = _aabb.max.z - _pBox.min.z;
        const minD = Math.min(dx1, dx2, dy1, dy2, dz1, dz2);

        if (minD === dy2 && vel.y <= 0) { pos.y = _aabb.max.y; vel.y = 0; player.onGround = true; }
        else if (minD === dy1 && vel.y > 0) { pos.y = _aabb.min.y - h; vel.y = 0; }
        else if (minD === dx1) pos.x = _aabb.min.x - r - 0.001;
        else if (minD === dx2) pos.x = _aabb.max.x + r + 0.001;
        else if (minD === dz1) pos.z = _aabb.min.z - r - 0.001;
        else if (minD === dz2) pos.z = _aabb.max.z + r + 0.001;
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
