# three.js 0.186.1（vendored）

3D 頁執行時不連任何 CDN：three.js 直接放在這裡，由 index.html 的 importmap 指過來。

- 來源：npm registry 官方套件 `https://registry.npmjs.org/three/-/three-0.186.1.tgz`
- 完整性：`sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==`（npm registry 公布值；下載後以 SHA-512 比對相符才解壓）
- 取得日期：2026-10-01
- 授權：MIT（見同目錄 LICENSE）

| 檔案 | 位元組 | SHA-256 |
|---|---:|---|
| `three.module.js` | 662,772 | `9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea` |
| `three.core.js` | 1,458,113 | `9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6` |
| `addons/controls/OrbitControls.js` | 40,755 | `3d79d07ecb686b4e5d93232eedab255331c1beef711e13164eaa1f68655a5f2b` |
| `LICENSE` | 1,081 | `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc` |

`addons/` 的目錄結構比照官方 `three/addons/`（= `examples/jsm/`），
之後要加 BufferGeometryUtils 之類的擴充，放在同樣的相對路徑即可。

升級：重跑同樣流程換版本號，並在 test/ 跑一次回歸測試。
