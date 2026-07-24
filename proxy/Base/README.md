# Base — Qwen captcha source of truth

## Arquivo mandatório

| Arquivo | Papel |
|---------|--------|
| **`AliyunCaptcha.js`** | SDK oficial Aliyun Captcha 2.0 (bundle minificado) — **única base de verdade** |

**NÃO usar glm5.2proxy** como base para Qwen. Mesmo provedor Aliyun ≠ mesmo SceneId, region, verifyType, embed WAF, nem calibração de drag.

## O que o SDK ensina (Qwen)

1. `window.initAliyunCaptcha(config)` — Qwen já montou o widget; **não re-inicializar**.
2. `#waf_nc_block` presente → `verifyType` **1.0** (WAF embed).
3. Tipos: `TRACELESS` / `SLIDING` / `CHECK_BOX` / puzzle com `PuzzleImage` + `Image`.
4. Sucesso de verify no produto Qwen = rede `VerifyCaptcha*` com **`VerifyCode: T001`**.
5. `CertifyId` é por desafio; reuso/spam → falha tipo **F008** / LimitFlow.
6. IDs de UI do puzzle vêm do JS dinâmico do desafio, não deste bundle — no DOM Qwen:
   - `#aliyunCaptcha-sliding-slider` ← **só arrasta isto (seta roxa)**
   - `#aliyunCaptcha-puzzle` ← `style.left` = posição da peça
   - `#aliyunCaptcha-img` ← fundo
   - `#aliyunCaptcha-btn-refresh` ← novo desafio

## Solver Qwen (código)

| Path | Função |
|------|--------|
| `src/services/qwen-puzzle-solver.ts` | Drag + verify T001 |
| `src/services/aliyun-vision.mjs` | Onde está o buraco (X) |
| `src/services/waf-captcha-assist.ts` | Form SPA → captcha → tokens |

## Leis

- Zero mutação de CSS do captcha
- Zero re-init do `initAliyunCaptcha`
- Zero `page.evaluate` no meio do drag (F011)
- Travel Qwen embed ≈ `targetDisplayX` (1:1) + no máximo 1 correção no fim
- Só `T001` conta

## Doctrine (agentes)

Ver `Base/QWEN-CAPTCHA-DOCTRINE.md` (gerado após forense).
