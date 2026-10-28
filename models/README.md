# models/ — 3D 模型（VRM）

## AvatarSample_A.vrm

- 來源：VRoid Studio 官方樣板模型（`AvatarSample_A`），透過 [madjin/vrm-samples](https://github.com/madjin/vrm-samples) 取得。
- 授權：依 VRoid 官方說明（[樣板模型使用條件](https://vroid.pixiv.help/hc/en-us/articles/4402614652569)），
  AvatarSample_A/B/C 屬於「有條件可用」的模型：**可以修改、可以散布**，著作權未拋棄、需遵守官方條件。
- 用途：本專案的「更衣鏡 → VRM 模型」造型，以及 VRM 載入管線的驗證樣本。
- 要換成自己的角色：用 [VRoid Studio](https://vroid.com/studio)（免費）捏角色 → 匯出 `.vrm` → 蓋掉這個檔名即可。

## 技術備註

- VRM 是 glTF 的日系擴充：humanoid 骨骼 + blendshape 表情 + 彈簧骨（頭髮／衣擺物理）。
- 遊戲用 `@pixiv/three-vrm`（CDN，`importmap` 內）載入，**走路不需要動畫檔**：
  大廳既有的 sin 擺動直接轉 humanoid normalized bone（`getNormalizedBoneNode`）。
- 教訓：轉 `getRawBoneNode` 會被 `humanoid.update()` 覆蓋回 T-pose，一定要用 normalized bone。
