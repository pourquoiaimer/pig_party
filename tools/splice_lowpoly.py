# -*- coding: utf-8 -*-
"""
把 index.html 裡的「Kenney 方塊版低模」模組換成「Blender 柔和版」模組。
執行：python splice_lowpoly.py
（用字串切換，不用 patch 工具 —— 區塊很長，直接整段替換最保險）
"""
import io
import re
import sys

P = r"D:\hermes_\pig_party\index.html"
src = io.open(P, encoding="utf-8").read()

START = "const LOWPOLY = { ready: false"
END = "loadLowpoly();"

i = src.index(START)
# 往前吃掉區塊開頭的註解橫線（保留段落標題）
j = src.index(END, i) + len(END)

NEW = r'''const LOWPOLY = { ready: false, proto: null, matMap: null,
                  url: 'models/gudong-blender.glb?v=1' };

/** 把 Blender 模型掛到某個玩家身上（同一玩家只掛一次）。
 *  模型裡已經有節點階層（legL/legR/torsoG/skirtG/armL/armR/armL-elbow/headG），
 *  直接接到 p.legs / p.arms / p.torso / p.head / p.skirt，
 *  既有那套走路擺手、呼吸、裙擺搖的程式就原封不動繼續用 —— 不需要另外做動畫。
 */
function applyLowpoly(p) {
  if (!p || p.bodyKey !== 'lowpoly' || p.lowpoly || !LOWPOLY.ready) return;
  const model = LOWPOLY.proto.clone(true);
  model.scale.setScalar(0.88);          // Blender 模型高 3.23（含鹿角）→ 身體約 2.34，跟其他造型一致
  model.traverse(o => { if (o.isMesh) { o.userData.shared = true; o.castShadow = true; } });
  for (const c of p.group.children) c.visible = false;   // 程式身體整組隱藏
  p.group.add(model);

  const node = (n) => model.getObjectByName(n);
  const legL = node('legL'), legR = node('legR');
  const armL = node('armL'), armR = node('armR');
  const elbL = node('armL-elbow'), elbR = node('armR-elbow');
  const torsoG = node('torsoG'), skirtG = node('skirtG'), headG = node('headG');

  // 隊伍色：腰帶／裙襬滾邊／領口滾邊 本來共用同一個材質，這裡複製一份改成隊伍色
  const idx = Math.max(0, players.indexOf(p));
  const teamHex = mix(idx).cloth;
  const teamMat = new THREE.MeshToonMaterial({ color: teamHex, gradientMap: TOON_RAMP });
  teamMat.userData.shared = true;
  model.traverse(o => {
    if (o.isMesh && o.material && o.material.userData.gudongSash) o.material = teamMat;
  });

  // 描邊
  const meshes = [];
  model.traverse(o => { if (o.isMesh) meshes.push(o); });
  meshes.forEach(m => { const s = outlineOf(m, 0.10); s.userData.shared = true; });

  // 接上既有程式用的欄位
  if (legL && legR) p.legs = [legL, legR];
  if (armL && armR) {
    armL.elbow = elbL || new THREE.Object3D();
    armR.elbow = elbR || new THREE.Object3D();
    p.arms = [armL, armR];
  }
  if (torsoG) p.torso = torsoG;
  if (skirtG) p.skirt = skirtG;
  if (headG) p.head = headG;
  p.eyes = [];                  // 眼睛是幾何，不是可壓扁的貼圖/球 → blinkTick 會跳過
  p.faceMat = null;
  p.gloves = [new THREE.Object3D(), new THREE.Object3D()];   // 拳擊手套用不到，佔位避免 undefined
  p.lowpoly = { model };        // 只當標記用（走路動畫走既有程式，不用 mixer）
}

/** 載入模型（非同步）。載完時把已經選了低模造型的玩家換上去。 */
function loadLowpoly() {
  new GLTFLoader().load(LOWPOLY.url, (gltf) => {
    const src = gltf.scene;
    // 材質：Blender 匯出的是 PBR，這裡轉成跟其他造型一致的 toon（同色共用一份）
    const matMap = new Map();
    src.traverse(o => {
      if (!o.isMesh) return;
      const old = o.material;
      let m = matMap.get(old.uuid);
      if (!m) {
        m = new THREE.MeshToonMaterial({ color: old.color ? old.color.clone() : 0xffffff,
                                         gradientMap: TOON_RAMP });
        m.userData.shared = true;
        // 腰帶色（#54D9C0）在遊戲裡要換成隊伍色 → 打個記號讓 applyLowpoly 認得
        if (old.color && old.color.getHex() === 0x54d9c0) m.userData.gudongSash = true;
        matMap.set(old.uuid, m);
      }
      o.material = m;
      o.userData.shared = true;
    });
    LOWPOLY.proto = src;
    LOWPOLY.matMap = matMap;
    LOWPOLY.ready = true;
    players.forEach(applyLowpoly);
  }, undefined, (e) => {
    console.warn('[lowpoly] 模型載入失敗，維持程式身體：', e);
  });
}
loadLowpoly();'''

src = src[:i] + NEW + src[j:]

# 1) stepLobby 裡給 glTF 用的分支（現在不需要了，走路動畫回到既有程式）
m = re.search(r"\n    /\* 低模造型（glTF）：走路/待機交給模型內建的 walk／idle clip，.*?\n      return;\n    \}\n", src, re.S)
if m:
    src = src[:m.start()] + "\n" + src[m.end():]
    print("removed stepLobby lowpoly branch")
else:
    print("WARN: stepLobby branch not found")

# 2) 每幀 mixer 更新（新模型沒有 clip，不需要）
m2 = re.search(r"\n  // glTF 動作（低模造型）：不論在大廳還是小遊戲都要推.*?\n  for \(const mx of MIXERS\) mx\.update\(dt\);\n", src, re.S)
if m2:
    src = src[:m2.start()] + "\n" + src[m2.end():]
    print("removed MIXERS update")
else:
    print("WARN: MIXERS update not found")

io.open(P, "w", encoding="utf-8", newline="").write(src)
print("done, bytes:", len(src.encode("utf-8")))
