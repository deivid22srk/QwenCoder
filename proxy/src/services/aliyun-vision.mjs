import sharp from 'sharp';
async function toRaw(input) {
    const img = sharp(input).ensureAlpha();
    const meta = await img.metadata();
    const raw = await img.raw().toBuffer();
    return { data: raw, width: meta.width, height: meta.height, channels: 4 };
}
function sobelEdge(img, useAlpha = false) {
    const { width, height, data, channels } = img;
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
        const r = data[i * channels];
        const g = data[i * channels + 1];
        const b = data[i * channels + 2];
        const a = data[i * channels + 3];
        if (useAlpha && a < 20) {
            gray[i] = 0;
        }
        else {
            gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }
    }
    const edges = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const gx = -gray[(y - 1) * width + (x - 1)] + gray[(y - 1) * width + (x + 1)] +
                -2 * gray[y * width + (x - 1)] + 2 * gray[y * width + (x + 1)] +
                -gray[(y + 1) * width + (x - 1)] + gray[(y + 1) * width + (x + 1)];
            const gy = -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)] +
                gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)];
            edges[y * width + x] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
        }
    }
    return edges;
}
function findPieceBounds(img) {
    let left = img.width, top = img.height, right = 0, bottom = 0;
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const a = img.data[(y * img.width + x) * img.channels + 3];
            if (a > 20) {
                if (x < left)
                    left = x;
                if (x > right)
                    right = x;
                if (y < top)
                    top = y;
                if (y > bottom)
                    bottom = y;
            }
        }
    }
    return { left, top, right, bottom };
}
/** Skip left starter silhouette that Aliyun paints on the bg (false match). */
function minSearchX(bgW, pieceW) {
    // Starter ghost outline lives ~[0, pieceW+48]; real hole almost always mid/right.
    return Math.max(pieceW + 48, Math.floor(bgW * 0.3), 90);
}

/**
 * Dual-polarity hole score:
 *  - bright holes (white fog/cutout) OR dark residual cuts
 *  - prefer uniform interior (low std) + edge response on mask
 */
function detectGap(bg, pz, bounds) {
    const { width, data, channels } = bg;
    const bgEdges = sobelEdge(bg);
    const scores = [];
    const pieceW = bounds.right - bounds.left + 1;
    const pieceMask = [];
    const stepX = Math.max(1, Math.floor(pieceW / 20));
    const stepY = Math.max(1, Math.floor((bounds.bottom - bounds.top + 1) / 20));
    for (let y = bounds.top; y <= bounds.bottom; y += stepY) {
        for (let x = bounds.left; x <= bounds.right; x += stepX) {
            const a = pz.data[(y * pz.width + x) * pz.channels + 3];
            if (a > 20) {
                pieceMask.push({ dx: x - bounds.left, y });
            }
        }
    }
    const ox0 = minSearchX(width, pieceW);
    for (let ox = ox0; ox <= width - pieceW; ox++) {
        let brightnessSum = 0;
        let brightnessSqSum = 0;
        let edgeSum = 0;
        let count = 0;
        for (const pt of pieceMask) {
            const px = ox + pt.dx;
            const py = pt.y;
            if (px >= width)
                continue;
            const idx = (py * width + px) * channels;
            const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            brightnessSum += brightness;
            brightnessSqSum += brightness * brightness;
            edgeSum += bgEdges[py * width + px];
            count++;
        }
        if (count === 0) {
            scores.push({ x: ox, score: 0 });
            continue;
        }
        const meanBrightness = brightnessSum / count;
        const variance = Math.max(0, brightnessSqSum / count - meanBrightness * meanBrightness);
        const brightnessStd = Math.sqrt(variance);
        const meanEdge = edgeSum / count;
        // Uniform fill (hole) scores better than textured photo
        const uniformity = Math.max(0, 80 - brightnessStd);
        const brightHole = meanBrightness + uniformity * 0.55 + meanEdge * 0.1;
        const darkHole = (255 - meanBrightness) + uniformity * 0.55 + meanEdge * 0.1;
        scores.push({ x: ox, score: Math.max(brightHole, darkHole) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}

/** Distinct peaks from a sorted score list (x far enough apart). */
function distinctPeaks(scores, minSep = 14, limit = 5) {
    const out = [];
    for (const s of scores) {
        if (!Number.isFinite(s.x)) continue;
        if (out.some((p) => Math.abs(p.x - s.x) < minSep)) continue;
        out.push(s);
        if (out.length >= limit) break;
    }
    return out;
}

export function analyzeMatchQuality(match) {
    const top = match.scores?.[0]?.score;
    const competing = (match.scores || []).find((score) => Math.abs(score.x - match.x) > 12);
    const competingScore = competing?.score;
    const topGap = typeof top === 'number' && typeof competingScore === 'number'
        ? Number((top - competingScore).toFixed(4))
        : null;
    const topRatio = typeof top === 'number' && typeof competingScore === 'number' && Math.abs(top) > 0.0001
        ? Number((competingScore / top).toFixed(4))
        : null;
    const componentXs = [match.contourX, match.edgeX, match.gapX, match.brightX, match.nccX]
        .filter((value) => Number.isFinite(value) && value >= 0);
    const componentEntries = [
        { name: 'contour', x: match.contourX },
        { name: 'edge', x: match.edgeX },
        { name: 'gap', x: match.gapX },
        { name: 'bright', x: match.brightX },
        { name: 'ncc', x: match.nccX },
    ].filter((entry) => Number.isFinite(entry.x) && entry.x >= 0);
    const componentSpread = componentXs.length >= 2
        ? Math.max(...componentXs) - Math.min(...componentXs)
        : null;
    const componentsNearFinal = componentEntries.filter((entry) => Math.abs(entry.x - match.x) <= 10);
    const reasons = [];
    if (match.confidence < 0.55)
        reasons.push('low_confidence');
    if (topRatio !== null && topRatio > 0.97)
        reasons.push('close_second_score');
    if (topGap !== null && topGap < 0.02)
        reasons.push('small_top_gap');
    if (componentSpread !== null && componentSpread > 50 && componentsNearFinal.length < 2) {
        reasons.push('component_disagreement');
    }
    // Structural methods near final → trust them; ignore gap/bright sky disagreement
    const edgeNearFinal = Number.isFinite(match.edgeX) && Math.abs(match.edgeX - match.x) <= 12;
    const contourNearFinal = Number.isFinite(match.contourX) && Math.abs(match.contourX - match.x) <= 12;
    const structuralOk = edgeNearFinal && contourNearFinal;

    // Two strong methods agree far from final → split brain (skip if structural holds)
    if (!structuralOk) {
        for (let i = 0; i < componentEntries.length; i++) {
            for (let j = i + 1; j < componentEntries.length; j++) {
                const left = componentEntries[i];
                const right = componentEntries[j];
                const clusterX = (left.x + right.x) / 2;
                if (Math.abs(left.x - right.x) <= 6 &&
                    Math.abs(clusterX - match.x) > 14 &&
                    match.confidence < 0.88) {
                    // gap+bright alone often latch onto sky — only count if one is structural
                    const structuralPair =
                        (left.name === 'edge' || left.name === 'contour' ||
                            right.name === 'edge' || right.name === 'contour');
                    if (!structuralPair) continue;
                    reasons.push(`split_component_cluster:${left.name}+${right.name}`);
                    i = componentEntries.length;
                    break;
                }
            }
        }
    }
    return {
        ambiguous: reasons.length > 0,
        reasons,
        topGap,
        topRatio,
        competingX: competing?.x ?? null,
        componentSpread,
        componentXs,
    };
}
function nccMatch(bg, pz, bounds) {
    const { width: bgW, height: bgH, data: bgData, channels: bgCh } = bg;
    const { width: pzW, data: pzData, channels: pzCh } = pz;
    const pieceW = bounds.right - bounds.left + 1;
    const pieceH = bounds.bottom - bounds.top + 1;
    const tmplPixels = [];
    let tmplSum = 0;
    const stepX = Math.max(1, Math.floor(pieceW / 30));
    const stepY = Math.max(1, Math.floor(pieceH / 30));
    for (let dy = bounds.top; dy <= bounds.bottom; dy += stepY) {
        for (let dx = bounds.left; dx <= bounds.right; dx += stepX) {
            const a = pzData[(dy * pzW + dx) * pzCh + 3];
            if (a < 30)
                continue;
            const idx = (dy * pzW + dx) * pzCh;
            const gray = 0.299 * pzData[idx] + 0.587 * pzData[idx + 1] + 0.114 * pzData[idx + 2];
            tmplPixels.push({ dx: dx - bounds.left, dy: dy - bounds.top, gray });
            tmplSum += gray;
        }
    }
    const tmplMean = tmplSum / tmplPixels.length;
    let tmplVar = 0;
    for (const p of tmplPixels)
        tmplVar += (p.gray - tmplMean) ** 2;
    const tmplStd = Math.sqrt(tmplVar) || 1;
    const scores = [];
    const ox0 = minSearchX(bgW, pieceW);
    for (let ox = ox0; ox <= bgW - pieceW; ox++) {
        let crossSum = 0;
        let bgSum = 0;
        let bgSum2 = 0;
        let count = 0;
        for (const p of tmplPixels) {
            const bx = ox + p.dx;
            const by = bounds.top + p.dy;
            if (bx >= bgW || by >= bgH)
                continue;
            const idx = (by * bgW + bx) * bgCh;
            const gray = 0.299 * bgData[idx] + 0.587 * bgData[idx + 1] + 0.114 * bgData[idx + 2];
            crossSum += (p.gray - tmplMean) * gray;
            bgSum += gray;
            bgSum2 += gray * gray;
            count++;
        }
        if (count === 0) {
            scores.push({ x: ox, score: 0 });
            continue;
        }
        const bgMean = bgSum / count;
        let bgVar = 0;
        for (const p of tmplPixels) {
            const bx = ox + p.dx;
            const by = bounds.top + p.dy;
            if (bx >= bgW || by >= bgH)
                continue;
            const idx = (by * bgW + bx) * bgCh;
            const gray = 0.299 * bgData[idx] + 0.587 * bgData[idx + 1] + 0.114 * bgData[idx + 2];
            bgVar += (gray - bgMean) ** 2;
        }
        const bgStd = Math.sqrt(bgVar) || 1;
        const ncc = crossSum / (tmplStd * bgStd);
        scores.push({ x: ox, score: ncc });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function edgeMatch(bg, pz, bounds) {
    const bgEdges = sobelEdge(bg);
    const pzEdges = sobelEdge(pz, true);
    const pieceW = bounds.right - bounds.left + 1;
    const edgePoints = [];
    for (let y = bounds.top; y <= bounds.bottom; y++) {
        for (let x = bounds.left; x <= bounds.right; x++) {
            const a = pz.data[(y * pz.width + x) * pz.channels + 3];
            const e = pzEdges[y * pz.width + x];
            if (a > 20 && e > 30) {
                edgePoints.push({ x: x - bounds.left, y, strength: e });
            }
        }
    }
    edgePoints.sort((a, b) => b.strength - a.strength);
    const sampled = edgePoints.slice(0, Math.min(edgePoints.length, 800));
    const scores = [];
    const maxX = bg.width - pieceW;
    const ox0 = minSearchX(bg.width, pieceW);
    for (let ox = ox0; ox <= maxX; ox++) {
        let totalScore = 0;
        let count = 0;
        for (const pt of sampled) {
            const bx = ox + pt.x;
            const by = pt.y;
            if (bx >= 0 && bx < bg.width && by >= 0 && by < bg.height) {
                const bgEdgeVal = bgEdges[by * bg.width + bx];
                totalScore += bgEdgeVal;
                count++;
            }
        }
        scores.push({ x: ox, score: count > 0 ? totalScore / count : 0 });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function contourMatch(bg, pz, bounds) {
    const bgEdges = sobelEdge(bg);
    const contourPoints = [];
    const minX = bounds.left;
    const minY = bounds.top;
    const pieceW = bounds.right - bounds.left + 1;
    for (let y = bounds.top; y <= bounds.bottom; y++) {
        for (let x = bounds.left; x <= bounds.right; x++) {
            const idx = (y * pz.width + x) * pz.channels + 3;
            const alpha = pz.data[idx];
            if (alpha <= 20)
                continue;
            let isBoundary = false;
            for (let oy = -1; oy <= 1 && !isBoundary; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0)
                        continue;
                    const nx = x + ox;
                    const ny = y + oy;
                    if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) {
                        isBoundary = true;
                        break;
                    }
                    const neighborAlpha = pz.data[(ny * pz.width + nx) * pz.channels + 3];
                    if (neighborAlpha <= 20) {
                        isBoundary = true;
                        break;
                    }
                }
            }
            if (isBoundary) {
                contourPoints.push({ x: x - minX, y: y - minY });
            }
        }
    }
    const sampled = contourPoints.filter((_, index) => index % 2 === 0);
    const scores = [];
    const ox0 = minSearchX(bg.width, pieceW);
    for (let ox = ox0; ox <= bg.width - pieceW; ox++) {
        let sum = 0;
        let count = 0;
        for (const pt of sampled) {
            const bx = ox + pt.x;
            const by = minY + pt.y;
            if (bx >= 0 && bx < bg.width && by >= 0 && by < bg.height) {
                sum += bgEdges[by * bg.width + bx];
                count++;
            }
        }
        scores.push({ x: ox, score: count > 0 ? sum / count : 0 });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}
function normalizeScores(scores) {
    if (scores.length === 0)
        return new Map();
    const min = Math.min(...scores.map(s => s.score));
    const max = Math.max(...scores.map(s => s.score));
    const range = max - min || 1;
    const map = new Map();
    for (const s of scores) {
        map.set(s.x, (s.score - min) / range);
    }
    return map;
}
function pickConsensusX(fallbackX, candidates) {
    const usable = candidates.filter((candidate) => Number.isFinite(candidate.x) && candidate.x >= 0);
    if (usable.length < 2)
        return fallbackX;
    const tolerance = 14;
    let bestCluster = null;
    for (const anchor of usable) {
        const members = usable.filter((candidate) => Math.abs(candidate.x - anchor.x) <= tolerance);
        if (members.length < 2)
            continue;
        const totalWeight = members.reduce((sum, member) => sum + member.weight, 0);
        const center = members.reduce((sum, member) => sum + member.x * member.weight, 0) / totalWeight;
        const spread = members.reduce((sum, member) => sum + Math.abs(member.x - center), 0) / members.length;
        const cluster = {
            members,
            count: members.length,
            weight: totalWeight,
            spread,
        };
        if (!bestCluster ||
            cluster.count > bestCluster.count ||
            (cluster.count === bestCluster.count && cluster.weight > bestCluster.weight) ||
            (cluster.count === bestCluster.count && cluster.weight === bestCluster.weight && cluster.spread < bestCluster.spread)) {
            bestCluster = cluster;
        }
    }
    if (!bestCluster)
        return fallbackX;
    const avg = bestCluster.members.reduce((sum, member) => sum + member.x * member.weight, 0) /
        bestCluster.weight;
    return Math.round(avg);
}
/**
 * Bright cutout detector — real Aliyun holes are lighter AND contrast vs sides
 * AND have edge energy on the piece silhouette. Snow fields fail contrast → low score.
 */
function brightHoleMatch(bg, pz, bounds) {
    const pieceW = bounds.right - bounds.left + 1;
    const ox0 = minSearchX(bg.width, pieceW);
    const bgEdges = sobelEdge(bg);
    const mask = [];
    const boundary = [];
    const stepX = Math.max(1, Math.floor(pieceW / 16));
    const stepY = Math.max(1, Math.floor((bounds.bottom - bounds.top + 1) / 16));
    for (let y = bounds.top; y <= bounds.bottom; y += stepY) {
        for (let x = bounds.left; x <= bounds.right; x += stepX) {
            const a = pz.data[(y * pz.width + x) * pz.channels + 3];
            if (a <= 30) continue;
            const dx = x - bounds.left;
            const dy = y - bounds.top;
            mask.push({ dx, dy });
            // boundary if any neighbor is transparent
            let isB = false;
            for (let oy = -1; oy <= 1 && !isB; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0) continue;
                    const nx = x + ox, ny = y + oy;
                    if (nx < 0 || ny < 0 || nx >= pz.width || ny >= pz.height) {
                        isB = true;
                        break;
                    }
                    if (pz.data[(ny * pz.width + nx) * pz.channels + 3] <= 30) {
                        isB = true;
                        break;
                    }
                }
            }
            if (isB) boundary.push({ dx, dy });
        }
    }
    const scores = [];
    const pad = Math.max(5, Math.floor(pieceW * 0.22));
    for (let ox = ox0; ox <= bg.width - pieceW; ox++) {
        let inSum = 0, inCount = 0, inSq = 0;
        let outSum = 0, outCount = 0;
        let edgeOnBoundary = 0, bCount = 0;
        for (const pt of mask) {
            const bx = ox + pt.dx;
            const by = bounds.top + pt.dy;
            if (bx < 0 || bx >= bg.width || by < 0 || by >= bg.height) continue;
            const idx = (by * bg.width + bx) * bg.channels;
            const br = (bg.data[idx] + bg.data[idx + 1] + bg.data[idx + 2]) / 3;
            inSum += br;
            inSq += br * br;
            inCount++;
        }
        for (const pt of boundary) {
            const bx = ox + pt.dx;
            const by = bounds.top + pt.dy;
            if (bx < 0 || bx >= bg.width || by < 0 || by >= bg.height) continue;
            edgeOnBoundary += bgEdges[by * bg.width + bx];
            bCount++;
        }
        for (let y = bounds.top; y <= bounds.bottom; y += stepY) {
            for (const side of [-pad, pieceW + pad]) {
                const bx = ox + side;
                if (bx < 0 || bx >= bg.width) continue;
                const idx = (y * bg.width + bx) * bg.channels;
                outSum += (bg.data[idx] + bg.data[idx + 1] + bg.data[idx + 2]) / 3;
                outCount++;
            }
        }
        if (inCount === 0) {
            scores.push({ x: ox, score: 0, meanIn: 0, contrast: 0, boundaryEdge: 0 });
            continue;
        }
        const meanIn = inSum / inCount;
        const meanOut = outCount > 0 ? outSum / outCount : meanIn;
        const variance = Math.max(0, inSq / inCount - meanIn * meanIn);
        const std = Math.sqrt(variance);
        const contrast = meanIn - meanOut;
        const meanBoundEdge = bCount > 0 ? edgeOnBoundary / bCount : 0;
        // Snow field: meanIn high but contrast ~0 → score dies. Real cutout: contrast+boundary.
        const score =
            Math.max(0, contrast) * 2.2 +
            Math.max(0, meanIn - 140) * 0.35 +
            Math.max(0, 55 - std) * 0.5 +
            meanBoundEdge * 0.45;
        scores.push({ x: ox, score, meanIn, contrast, boundaryEdge: meanBoundEdge });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
}

function clampInt(v, a, b) {
    return Math.min(b, Math.max(a, Math.round(v)));
}

/**
 * Pick hole X from multi-method votes.
 * LAW: edge+contour agreement wins (real cutout outline).
 * White hole only with contrast (snow fails → structural keeps).
 * Never trust bright alone. Never trust left ghost when mid/right signal exists.
 */
function resolveFinalX(edgeTop, contourTop, gapTop, brightTop, ensembleBest, pieceW = 52, extras = {}) {
    const e = edgeTop?.x;
    const c = contourTop?.x;
    const g = gapTop?.x;
    const b = brightTop?.x;
    const ens = ensembleBest?.x;
    const edgePeaks = extras.edgePeaks || [];
    const contourPeaks = extras.contourPeaks || [];
    const HARD = 10;
    const SOFT = 16;
    const GHOST_MAX = Math.max(pieceW + 24, 115);
    const finite = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    const structMean = (ee, cc) => Math.round((ee * 1.15 + cc) / 2.15);
    const isGhost = (x) => finite(x) && x < GHOST_MAX;
    const whiteHoleOk = () => {
        const meanIn = brightTop?.meanIn ?? 0;
        const contrast = brightTop?.contrast ?? 0;
        const be = brightTop?.boundaryEdge ?? 0;
        // Strict: need real side contrast (kills snow false positives)
        return meanIn >= 150 && contrast >= 22 && be >= 12;
    };
    const holeAgree = () =>
        finite(b) && finite(g) && Math.abs(b - g) <= 14 && whiteHoleOk();
    const holeMean = () => Math.round((b + g) / 2);

    // Structural pair: only top-3 peaks, skip ghost zone (x<115), prefer tight pairs.
    // Must be near at least one rank-1 (e or c) so we don't invent pairs from weak peaks.
    let bestStruct = null;
    const ePeaks = edgePeaks.length ? edgePeaks : (finite(e) ? [{ x: e, score: 1 }] : []);
    const cPeaks = contourPeaks.length ? contourPeaks : (finite(c) ? [{ x: c, score: 1 }] : []);
    for (const ep of ePeaks) {
        for (const cp of cPeaks) {
            if (!finite(ep.x) || !finite(cp.x)) continue;
            const d = Math.abs(ep.x - cp.x);
            if (d > SOFT) continue;
            const S = structMean(ep.x, cp.x);
            if (S < 115) continue; // left ghost / starter silhouette
            if (isGhost(S) && holeAgree() && holeMean() - S > 35) continue;
            // Must sit near rank-1 edge OR rank-1 contour (no free secondary×secondary)
            const nearRank1 =
                (finite(e) && Math.abs(e - S) <= 16) ||
                (finite(c) && Math.abs(c - S) <= 16);
            if (!nearRank1) continue;
            const quality =
                (d <= HARD ? 3 : 1.2) +
                (S >= 140 ? 0.8 : 0) +
                (nearRank1 ? 0.6 : 0) -
                d * 0.05;
            if (!bestStruct || quality > bestStruct.quality) {
                bestStruct = { x: S, d, quality, hard: d <= HARD };
            }
        }
    }

    // 1) Strong structural lock
    if (bestStruct && bestStruct.hard) {
        const S = bestStruct.x;
        if (holeAgree()) {
            const H = holeMean();
            if (Math.abs(H - S) <= 18) {
                return { x: Math.round(S * 0.72 + H * 0.28), method: 'struct+hole' };
            }
        }
        // gap near structure (no bright required)
        if (finite(g) && Math.abs(g - S) <= 14 && !isGhost(S)) {
            return { x: Math.round(S * 0.75 + g * 0.25), method: 'struct+gap' };
        }
        return { x: S, method: 'structural(edge+contour)' };
    }

    // 2) Soft structural
    if (bestStruct && !bestStruct.hard) {
        const S = bestStruct.x;
        if (holeAgree() && Math.abs(holeMean() - S) <= 16) {
            return { x: Math.round(S * 0.6 + holeMean() * 0.4), method: 'struct-soft+hole' };
        }
        if (finite(ens) && Math.abs(ens - S) <= 12) {
            return { x: Math.round(S * 0.8 + ens * 0.2), method: 'structural+ens' };
        }
        return { x: S, method: 'structural(edge+contour-soft)' };
    }

    // 3) Classic rank-1 structural if peaks failed
    if (finite(e) && finite(c) && Math.abs(e - c) <= SOFT) {
        const S = structMean(e, c);
        if (!(isGhost(S) && holeAgree() && holeMean() - S > 35)) {
            return { x: S, method: 'structural(edge+contour)' };
        }
    }

    // 4) Real white hole (contrast-gated) — never ghost
    if (holeAgree()) {
        const H = holeMean();
        if (!isGhost(H)) {
            if (finite(e) && Math.abs(e - H) <= 18) {
                return { x: Math.round(e * 0.5 + H * 0.5), method: 'edge+whiteHole' };
            }
            if (finite(c) && Math.abs(c - H) <= 18) {
                return { x: Math.round(c * 0.5 + H * 0.5), method: 'contour+whiteHole' };
            }
            // Edge far right of weak hole → edge wins (false left bright patch)
            if (finite(e) && e - H > 28 && e >= 150) {
                return { x: Math.round(e), method: 'edge-over-falseHole' };
            }
            return { x: H, method: 'whiteHole(bright+gap)' };
        }
    }

    // 5) Pairs — NO bare bright without whiteHoleOk
    if (finite(e) && finite(g) && Math.abs(e - g) <= 12 && !isGhost(e)) {
        return { x: Math.round((e + g) / 2), method: 'edge+gap' };
    }
    if (finite(c) && finite(g) && Math.abs(c - g) <= 12 && !isGhost(c)) {
        return { x: Math.round((c + g) / 2), method: 'contour+gap' };
    }
    if (finite(e) && finite(b) && Math.abs(e - b) <= 12 && whiteHoleOk()) {
        return { x: Math.round((e + b) / 2), method: 'edge+bright' };
    }
    if (finite(e) && !isGhost(e)) {
        return { x: Math.round(e), method: 'edge' };
    }
    if (finite(c) && !isGhost(c)) {
        return { x: Math.round(c), method: 'contour' };
    }
    if (finite(ens) && !isGhost(ens)) {
        return { x: ens, method: 'ensemble' };
    }
    return { x: e ?? c ?? g ?? b ?? ens ?? 0, method: 'fallback' };
}

/**
 * Prefer structural methods (edge+contour) when they agree.
 * Gap/NCC often latch onto bright waterfalls / sky and pull ensemble left.
 * Forensic (Qwen embed 300x200): a1 hole ~228, ensemble wrongly picked 125;
 * edge=228 contour=217 — forcing structural agreement recovers the hole.
 */
function resolveStructuralX(edgeTop, contourTop, gapTop, ensembleBestX, brightTop) {
    const edgeX = edgeTop?.x;
    const contourX = contourTop?.x;
    const gapX = gapTop?.x;
    if (Number.isFinite(edgeX) && Number.isFinite(contourX) && Math.abs(edgeX - contourX) <= 16) {
        const structural = Math.round((edgeX * 1.1 + contourX * 1.0) / 2.1);
        // If ensemble is far from both structural tops, trust structure
        if (Math.abs(ensembleBestX - structural) > 18) {
            return { x: structural, method: 'structural(edge+contour)' };
        }
        // Mild pull toward structure when close-ish
        if (Math.abs(ensembleBestX - structural) > 8) {
            return {
                x: Math.round(ensembleBestX * 0.35 + structural * 0.65),
                method: 'blend(ensemble+structural)',
            };
        }
    }
    // edge+gap agreement without contour (gap can work on flat holes)
    if (Number.isFinite(edgeX) && Number.isFinite(gapX) && Math.abs(edgeX - gapX) <= 14) {
        const pair = Math.round((edgeX + gapX) / 2);
        if (Math.abs(ensembleBestX - pair) > 20) {
            return { x: pair, method: 'structural(edge+gap)' };
        }
    }
    // contour+gap
    if (Number.isFinite(contourX) && Number.isFinite(gapX) && Math.abs(contourX - gapX) <= 14) {
        const pair = Math.round((contourX + gapX) / 2);
        if (Math.abs(ensembleBestX - pair) > 20) {
            return { x: pair, method: 'structural(contour+gap)' };
        }
    }
    // Bright hole alone when structural disagree and ensemble is weak vs bright peak
    const brightX = brightTop?.x;
    if (Number.isFinite(brightX) && Number.isFinite(edgeX) && Math.abs(edgeX - brightX) <= 18) {
        const pair = Math.round((edgeX * 0.55 + brightX * 0.45));
        if (Math.abs(ensembleBestX - pair) > 16) {
            return { x: pair, method: 'structural(edge+bright)' };
        }
    }
    if (Number.isFinite(brightX) && Number.isFinite(contourX) && Math.abs(contourX - brightX) <= 18) {
        const pair = Math.round((contourX * 0.55 + brightX * 0.45));
        if (Math.abs(ensembleBestX - pair) > 16) {
            return { x: pair, method: 'structural(contour+bright)' };
        }
    }
    return null;
}

export async function templateMatch(backgroundInput, puzzleInput) {
    const bg = await toRaw(backgroundInput);
    const pz = await toRaw(puzzleInput);
    const bounds = findPieceBounds(pz);
    const pieceW = bounds.right - bounds.left + 1;
    const pieceH = bounds.bottom - bounds.top + 1;
    const edgeScores = edgeMatch(bg, pz, bounds);
    const contourScores = contourMatch(bg, pz, bounds);
    const gapScores = detectGap(bg, pz, bounds);
    const nccScores = nccMatch(bg, pz, bounds);
    const brightScores = brightHoleMatch(bg, pz, bounds);
    const edgeNorm = normalizeScores(edgeScores);
    const contourNorm = normalizeScores(contourScores);
    const gapNorm = normalizeScores(gapScores);
    const nccNorm = normalizeScores(nccScores);
    const brightNorm = normalizeScores(brightScores);
    const combined = [];
    // Structural dominates ensemble; bright is a weak tie-breaker only
    // (snow scenes destroy bright-heavy weights).
    const W_CONTOUR = 0.38;
    const W_EDGE = 0.38;
    const W_GAP = 0.12;
    const W_BRIGHT = 0.08;
    const W_NCC = 0.04;
    const ox0 = minSearchX(bg.width, pieceW);
    for (let ox = ox0; ox <= bg.width - pieceW; ox++) {
        const c = contourNorm.get(ox) ?? 0;
        const e = edgeNorm.get(ox) ?? 0;
        const b = brightNorm.get(ox) ?? 0;
        const g = gapNorm.get(ox) ?? 0;
        const n = nccNorm.get(ox) ?? 0;
        // Penalize left third slightly (ghost zone) unless structural is strong there
        const ghostPen = ox < bg.width * 0.32 ? 0.92 : 1;
        combined.push({
            x: ox,
            score: (c * W_CONTOUR + e * W_EDGE + b * W_BRIGHT + g * W_GAP + n * W_NCC) * ghostPen,
        });
    }
    combined.sort((a, b) => b.score - a.score);
    const best = combined[0];
    const edgeTop = edgeScores[0];
    const contourTop = contourScores[0];
    const gapTop = gapScores[0];
    const nccTop = nccScores[0];
    const brightTop = brightScores[0];
    const edgePeaks = distinctPeaks(edgeScores, 14, 4);
    const contourPeaks = distinctPeaks(contourScores, 14, 4);

    const resolved = resolveFinalX(edgeTop, contourTop, gapTop, brightTop, best, pieceW, {
        edgePeaks,
        contourPeaks,
    });
    let final = combined.find((s) => s.x === resolved.x)
        || { x: resolved.x, score: best?.score ?? 0.5 };
    if (!combined.find((s) => s.x === resolved.x)) {
        const near = combined.reduce((a, s) =>
            Math.abs(s.x - resolved.x) < Math.abs(a.x - resolved.x) ? s : a,
            combined[0]);
        final = { x: resolved.x, score: near?.score ?? 0.5 };
    }
    // Local refine on EDGE scores only around final (±5) — sharper than ensemble blur
    {
        const radius = 5;
        const nearEdge = edgeScores.filter((s) => Math.abs(s.x - final.x) <= radius);
        if (nearEdge.length >= 3) {
            const wsum = nearEdge.reduce((a, s) => a + Math.max(0.01, s.score), 0);
            const refined = Math.round(
                nearEdge.reduce((a, s) => a + s.x * Math.max(0.01, s.score), 0) / wsum,
            );
            if (Math.abs(refined - final.x) <= radius) {
                final = { x: refined, score: final.score };
            }
        }
    }
    let method = resolved.method;

    const peaks = distinctPeaks(combined, 16, 5);
    const candidates = peaks.map((p) => ({
        x: p.x,
        targetLeftX: Math.max(0, p.x - bounds.left),
        score: p.score,
    }));
    // Ensure final is first candidate
    if (!candidates.some((c) => Math.abs(c.x - final.x) <= 2)) {
        candidates.unshift({
            x: final.x,
            targetLeftX: Math.max(0, final.x - bounds.left),
            score: final.score,
        });
    } else {
        // move final to front
        const idx = candidates.findIndex((c) => Math.abs(c.x - final.x) <= 2);
        if (idx > 0) {
            const [c] = candidates.splice(idx, 1);
            candidates.unshift(c);
        }
    }

    const result = {
        x: final.x,
        targetLeftX: Math.max(0, final.x - bounds.left),
        confidence: final.score,
        scores: combined.slice(0, 12),
        candidates: candidates.slice(0, 5),
        method,
        edgeX: edgeTop?.x ?? -1,
        contourX: contourTop?.x ?? -1,
        gapX: gapTop?.x ?? -1,
        nccX: nccTop?.x ?? -1,
        brightX: brightTop?.x ?? -1,
        pieceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            width: pieceW,
            height: pieceH,
        },
    };
    result.quality = analyzeMatchQuality(result);
    return result;
}
//# sourceMappingURL=vision.js.map