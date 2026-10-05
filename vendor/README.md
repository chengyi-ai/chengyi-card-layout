# 本地第三方浏览器依赖

这些文件是产品运行时直接加载的固定版本浏览器依赖。构建会校验文件的
SHA-256，避免来源不明或版本漂移。更新任一文件时，必须同时更新精确版本、
下载地址、SHA-256 和相邻的完整许可证文本。

| 文件 | 包与版本 | 精确来源 | 许可证 | SHA-256 |
| --- | --- | --- | --- | --- |
| `vendor/html2canvas.min.js` | `html2canvas` 1.4.1 | `https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js` | MIT | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` |
| `vendor/jszip.min.js` | `JSZip` 3.10.1（内含 Pako 1.0.5） | `https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js` | MIT（JSZip 另可选 GPL-3.0-or-later） | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |

完整许可证：

- `vendor/LICENSE.html2canvas.txt`
- `vendor/LICENSE.jszip.txt`
- `vendor/LICENSE.pako.txt`

图文工具已有的 mp4box.js 和 mp4-muxer 继续使用各自相邻的许可证文本。
