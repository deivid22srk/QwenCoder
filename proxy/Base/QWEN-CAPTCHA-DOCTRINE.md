# Qwen captcha doctrine (AliyunCaptcha.js + DOM Qwen)

## Objetivo

Contas Qwen com captcha **rápido e estável**. Meta operacional: T001 em ≤3 tentativas na maioria dos casos. “Nunca falha” absoluto é marketing; a engenharia maximiza taxa e aborta limpo em F008/throttle.

## Fonte da lei

1. `Base/AliyunCaptcha.js` — SDK
2. DOM live Qwen (`#aliyunCaptcha-*`, `#waf_nc_block`)
3. Capturas `data/route-capture`, `data/full-session-capture`
4. Debug `data/captcha-debug/*`

**Proibido:** copiar stack glm5.2proxy como “base”.

## Pipeline

```
mail.tm → POST signup (HTTP)
  → WAF? → Playwright form + checkbox + Criar Conta
  → widget embed monta seta roxa
  → vision(bg,pz) → targetDisplayX
  → mouse drag only #aliyunCaptcha-sliding-slider
  → VerifyCode T001
  → signup?u_atoken&u_asig → email activate → login proof
```

## Readiness (antes do drag)

- `#aliyunCaptcha-img` complete, naturalWidth > 40
- `#aliyunCaptcha-puzzle` complete
- `#aliyunCaptcha-sliding-slider` visible, width > 10
- loading oculto
- `slider.style.left` ≈ 0 (desafio fresco)
- **Sem** alterar style/CSS do captcha

## Vision

```
targetLeftX = match.x - pieceBounds.left
scaleX = displayW / naturalW   // prefer img-box se existir
targetDisplayX = round(targetLeftX * scaleX + bias)  // bias default 0..1
```

- Ignorar silhueta fantasma esquerda (`minSearchX` ≥ ~28% largura)
- Preferir edge+contour se concordam
- Buraco branco só com contraste real (não céu/água)
- Refine local ±7px

## Drag

1. Press no centro da seta
2. Path suave 0.4–0.9s, Δx → `targetDisplayX`
3. **Proibido** `evaluate` no meio do gesto
4. No máximo **1** correção no fim se \|puzzle.left − target\| > 2.5
5. Release → esperar VerifyCaptcha

## Códigos (VerifyCaptcha — lei operacional)

| Code | Significado | Ação |
|------|------------|------|
| **T001** | Pass | sucesso, parar |
| **F015** | Peça fora do buraco | refresh + re-vision; nudge mm só após 2+ fails |
| **F011** | Freq. device **ou** gesto bot | gesto open-loop limpo; se repete → stop sessão |
| **F008** | Token/verify reusado / spam | **ABORT** imediato; cool longo; sem spam refresh |
| **F001** | Risk/score | 0–1 retry limpo; se repete stop |
| **F010** | Freq. IP | stop + back-off IP |
| **F024** | Click/drag simulado | gesto mais humano; sem evaluate mid-drag |
| LimitFlow / Throttling | Init throttle | parar, esperar |

Ignorar: cloudauth `Log*` `ResultObject:true` (não é captcha pass).

## Refresh

- Só `#aliyunCaptcha-btn-refresh` nativo
- Max 5 tentativas / conta
- F008 → stop imediato

## Nunca

- glm5.2proxy como calibragem default
- force CSS embed
- re-init SDK
- cloudauth Log como sucesso
- 10+ verifies seguidos
