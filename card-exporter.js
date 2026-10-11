// ===== 导出器 =====
class Exporter {
  static async exportImage(pages, buildAuthorHTML, baseName, progressEl, mediaContext = {}) {
    const container = document.getElementById('exportContainer');
    container.innerHTML = '';
    const pageResults = [];

    try {
      for (let i = 0; i < pages.length; i++) {
        progressEl.textContent = `\u6b63\u5728\u6e32\u67d3\u7b2c ${i + 1}/${pages.length} \u9875...`;
        const page = pages[i];
        const card = Renderer._buildCard(page, buildAuthorHTML);
        card.style.position = 'absolute';
        card.style.left = '0';
        card.style.top = '0';
        card.style.transform = 'none';
        card.style.margin = '0';
        container.appendChild(card);

        // 等待所有图片加载完成
        await Promise.all(
          Array.from(card.querySelectorAll('img')).map((img) =>
            img.complete ? Promise.resolve() : Promise.race([
              new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('图片加载超时，请检查图片后重试')), 12000)),
            ])
          )
        );
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await Renderer.prepareImageEffects(card);
        decorateHighlightStrokes(card);
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const canvas = await html2canvas(card, {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: null,
          width: CARD_W,
          height: CARD_H,
        });
        pageResults.push({
          canvas,
          media: Exporter._collectPageMedia(card, canvas),
        });
        container.removeChild(card);
      }
    } catch (err) {
      container.innerHTML = '';
      throw err;
    }

    container.innerHTML = '';

    if (pageResults.length === 0) {
      progressEl.style.display = 'none';
      return;
    }

    const canvasResults = pageResults.map((result) => result.canvas);
    const hasVideo = pageResults.some((result) => result.media.length > 0);

    if (hasVideo) {
      progressEl.textContent = '正在生成视频 / Live Photo…';
      const blob = await Exporter._buildMixedMediaZip(pageResults, baseName, progressEl, mediaContext);
      Exporter._downloadBlob(blob, `${baseName}.zip`);
      progressEl.textContent = `导出完成！共 ${pageResults.length} 页，已按原页序打包`;
      setTimeout(() => { progressEl.style.display = 'none'; }, 3000);
      return;
    }

    // 移动端优先走系统分享（iOS PWA 里 <a download> 经常无效，分享面板可存相册/文件）
    const shared = await Exporter._tryMobileShare(canvasResults, baseName, progressEl);
    if (!shared) {
      // 桌面 / 不支持分享的环境：单页下载 PNG，多页打包 ZIP
      if (canvasResults.length === 1) {
        progressEl.textContent = '正在导出...';
        const link = document.createElement('a');
        link.download = `${baseName}.png`;
        link.href = canvasResults[0].toDataURL('image/png');
        link.click();
      } else {
        progressEl.textContent = '正在打包 ZIP...';
        const zip = new JSZip();
        for (let i = 0; i < canvasResults.length; i++) {
          const dataURL = canvasResults[i].toDataURL('image/png');
          const base64 = dataURL.split(',')[1];
          zip.file(`${baseName}-${i + 1}.png`, base64, { base64: true });
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        Exporter._downloadBlob(blob, `${baseName}.zip`);
      }
    }

    progressEl.textContent = `导出完成！共 ${canvasResults.length} 张图片`;
    setTimeout(() => { progressEl.style.display = 'none'; }, 3000);
  }

  static _collectPageMedia(card, canvas) {
    const cardRect = card.getBoundingClientRect();
    if (!cardRect.width || !cardRect.height) throw new Error('导出卡片尺寸无效');
    const scaleX = canvas.width / cardRect.width;
    const scaleY = canvas.height / cardRect.height;
    return Array.from(card.querySelectorAll('img[data-media-kind="video"][data-media-id]')).map((img) => {
      const metadata = mediaMetadataFromNode(img);
      if (!metadata) throw new Error('视频块元数据不完整，请删除后重新插入');
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle ? window.getComputedStyle(img) : null;
      const borderLeft = Math.max(0, parseFloat(style?.borderLeftWidth) || 0);
      const borderTop = Math.max(0, parseFloat(style?.borderTopWidth) || 0);
      const borderRight = Math.max(0, parseFloat(style?.borderRightWidth) || 0);
      const borderBottom = Math.max(0, parseFloat(style?.borderBottomWidth) || 0);
      const contentWidth = Math.max(1, rect.width - borderLeft - borderRight);
      const contentHeight = Math.max(1, rect.height - borderTop - borderBottom);
      return {
        ...metadata,
        rect: {
          // 视频只覆盖图片内容区，保留相框/描边样式在视频上层。
          x: Math.max(0, Math.round((rect.left - cardRect.left + borderLeft) * scaleX)),
          y: Math.max(0, Math.round((rect.top - cardRect.top + borderTop) * scaleY)),
          width: Math.max(1, Math.round(contentWidth * scaleX)),
          height: Math.max(1, Math.round(contentHeight * scaleY)),
        },
      };
    });
  }

  static async _buildMixedMediaZip(pageResults, baseName, progressEl, mediaContext) {
    if (!window.JSZip) throw new Error('JSZip 未加载，无法打包视频内容');
    const accountId = String(mediaContext.accountId || '');
    const activeDraftId = String(mediaContext.draftId || '');
    if (!accountId || !activeDraftId) throw new Error('当前草稿信息不完整，无法读取视频素材');
    const store = await getCardMediaStore();
    const engine = await getLivePhotoEngine();
    const capability = engine.checkCapability?.();
    if (capability && !capability.supported) throw new Error(capability.message || '当前环境不支持视频合成');

    const zip = new window.JSZip();
    const expectedPaths = [];
    for (let index = 0; index < pageResults.length; index += 1) {
      const result = pageResults[index];
      const pageNumber = index + 1;
      const prefix = String(pageNumber).padStart(2, '0');
      if (result.media.length === 0) {
        const path = `${prefix}-图片.png`;
        const blob = await Exporter._canvasToBlob(result.canvas);
        zip.file(path, blob);
        expectedPaths.push(path);
        continue;
      }
      if (result.media.length > 1) {
        throw new Error(`第 ${pageNumber} 页包含 ${result.media.length} 个视频，当前每页只能生成一个视频或 Live Photo`);
      }
      const media = result.media[0];
      const sourceDraftId = media.sourceDraftId || activeDraftId;
      const asset = await store.get({
        accountId,
        draftId: sourceDraftId,
        mediaId: media.id,
        role: CARD_MEDIA_SOURCE_ROLE,
      });
      if (!asset?.blob) {
        throw new Error(`第 ${pageNumber} 页的视频素材不在当前设备，请删除该块后重新插入原视频`);
      }
      if (media.sourceDuration && media.startSeconds + media.durationSeconds > media.sourceDuration + 0.05) {
        throw new Error(`第 ${pageNumber} 页所选片段超出源视频时长，请调整开始时间或时长`);
      }
      const progress = ({ detail, progress: value }) => {
        const pct = Number.isFinite(Number(value)) ? ` ${Math.round(Number(value))}%` : '';
        progressEl.textContent = `第 ${pageNumber}/${pageResults.length} 页${pct} · ${detail || '正在处理视频…'}`;
      };
      const commonOptions = {
        videoBlob: asset.blob,
        cardCanvas: result.canvas,
        mediaRect: media.rect,
        rectSpace: 'output',
        startSeconds: media.startSeconds,
        durationSeconds: media.durationSeconds,
        coverOffsetSeconds: Math.min(0.2, media.durationSeconds / 2),
        keepSound: media.keepSound,
        outputWidth: CARD_W * 2,
        outputHeight: CARD_H * 2,
        clipRadius: 16,
        title: `${baseName}-${prefix}`,
        onProgress: progress,
      };

      if (media.mode === 'video') {
        const composed = await engine.composeCardVideo(commonOptions);
        if (!composed?.movieBytes?.byteLength) throw new Error(`第 ${pageNumber} 页视频生成结果为空`);
        const path = `${prefix}-视频.mp4`;
        zip.file(path, composed.movieBytes, { binary: true });
        expectedPaths.push(path);
      } else if (media.mode === 'live-photo') {
        const live = await engine.createLivePhotoPackage({
          ...commonOptions,
          platform: media.durationSeconds === 3 ? 'wechat' : 'xhs',
          zipOutputType: 'blob',
        });
        if (!Array.isArray(live?.parts) || live.parts.length === 0) {
          throw new Error(`第 ${pageNumber} 页 Live Photo 结果不完整`);
        }
        for (const part of live.parts) {
          const sourcePath = String(part.path || '');
          const marker = sourcePath.toLowerCase().indexOf('.pvt/');
          if (marker < 0 || !part.bytes) throw new Error(`第 ${pageNumber} 页 Live Photo 文件清单无效`);
          const relative = sourcePath.slice(marker + 5);
          const path = `${prefix}-实况.pvt/${relative}`;
          zip.file(path, part.bytes, { binary: true });
          expectedPaths.push(path);
        }
      } else {
        throw new Error(`第 ${pageNumber} 页视频输出模式无效`);
      }
    }

    progressEl.textContent = '正在校验导出包…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
    const reopened = await window.JSZip.loadAsync(blob);
    const missing = expectedPaths.filter((path) => !reopened.file(path));
    if (missing.length) throw new Error(`导出 ZIP 校验失败，缺少：${missing.join('、')}`);
    return blob;
  }

  static _canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG 生成失败')), 'image/png');
    });
  }

  static _downloadBlob(blob, filename) {
    const downloadURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = downloadURL;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 不能在 click 后立即 revoke：Safari / Chromium 可能尚未开始读取 Blob。
    setTimeout(() => URL.revokeObjectURL(downloadURL), 60_000);
  }

  // 移动端用 Web Share API 分享图片文件；不适用时返回 false 走下载逻辑
  static async _tryMobileShare(canvasResults, baseName, progressEl) {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile || !navigator.canShare) return false;

    progressEl.textContent = '正在准备分享...';
    const files = [];
    for (let i = 0; i < canvasResults.length; i++) {
      const blob = await new Promise((r) => canvasResults[i].toBlob(r, 'image/png'));
      if (!blob) return false;
      const suffix = canvasResults.length > 1 ? `-${i + 1}` : '';
      files.push(new File([blob], `${baseName}${suffix}.png`, { type: 'image/png' }));
    }

    if (!navigator.canShare({ files })) return false;
    try {
      await navigator.share({ files });
      return true;
    } catch (err) {
      // 用户取消分享也算处理完成，不再重复触发下载
      return err.name === 'AbortError';
    }
  }
}

window.CardLayoutRenderer = Renderer;
