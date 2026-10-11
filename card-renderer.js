// ===== 渲染器 =====
class Renderer {
  static _createImageElement(el, inCollage = false) {
      const S = STYLES;
      const img = document.createElement('img');
      img.src = el.src;
      img.style.width = inCollage ? '100%' : el.width;
      img.style.height = 'auto';
      img.style.maxWidth = inCollage ? 'none' : '100%';
      // 轻微圆角更接近常见截图排版，也和拼贴图片保持一致。
      img.style.borderRadius = '4px';
      img.style.margin = inCollage ? '0' : `${S.imageMargin}px auto`;
      img.style.display = 'block';
      if (el.media) applyMediaMetadataToImage(img, el.media);
      // 图片样式预设（分页测量与导出共用此函数，高度自动一致）
      if (el.frame === 'shadow') {
        // html2canvas 1.4.1 不支持 CSS box-shadow。投影必须先画进真实
        // Canvas 像素层，否则网页预览有投影、导出的 PNG/ZIP 却会变回普通版。
        const frame = document.createElement('div');
        frame.className = 'card-image-frame card-image-frame-shadow';
        frame.dataset.frame = 'shadow';
        frame.style.width = inCollage ? '100%' : el.width;

        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.className = 'card-image-shadow-canvas';
        shadowCanvas.setAttribute('aria-hidden', 'true');
        shadowCanvas.style.left = `-${IMAGE_SHADOW_INSETS.left}px`;
        shadowCanvas.style.top = `-${IMAGE_SHADOW_INSETS.top}px`;
        shadowCanvas.style.width = `calc(100% + ${IMAGE_SHADOW_INSETS.left + IMAGE_SHADOW_INSETS.right}px)`;
        shadowCanvas.style.height = `calc(100% + ${IMAGE_SHADOW_INSETS.top + IMAGE_SHADOW_INSETS.bottom}px)`;

        img.style.width = '100%';
        img.style.margin = '0';
        img.dataset.frame = 'shadow';
        frame.appendChild(shadowCanvas);
        frame.appendChild(img);
        return frame;
      } else if (el.frame === 'polaroid') {
        img.style.border = '12px solid #fff';
        img.style.borderRadius = '4px';
        img.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.18)';
      } else if (el.frame === 'outline') {
        img.style.border = '1px solid #ddd';
      } else if (el.frame === 'blue-border' && !inCollage) {
        // 单图蓝边直接复用自由拼贴的 Canvas 蓝色柔光，避免维护另一套近似颜色。
        const frame = document.createElement('div');
        frame.className = 'card-image-frame card-image-frame-blue-border';
        frame.dataset.frame = 'blue-border';
        frame.style.width = el.width;

        const shadowCanvas = document.createElement('canvas');
        shadowCanvas.className = 'card-image-shadow-canvas card-image-blue-shadow-canvas';
        shadowCanvas.setAttribute('aria-hidden', 'true');
        shadowCanvas.style.left = `-${IMAGE_SHADOW_INSETS.left}px`;
        shadowCanvas.style.top = `-${IMAGE_SHADOW_INSETS.top}px`;
        shadowCanvas.style.width = `calc(100% + ${IMAGE_SHADOW_INSETS.left + IMAGE_SHADOW_INSETS.right}px)`;
        shadowCanvas.style.height = `calc(100% + ${IMAGE_SHADOW_INSETS.top + IMAGE_SHADOW_INSETS.bottom}px)`;

        const glowCanvas = document.createElement('canvas');
        glowCanvas.className = 'card-collage-glow-canvas card-image-blue-glow-canvas';
        glowCanvas.setAttribute('aria-hidden', 'true');
        glowCanvas.style.left = `-${COLLAGE_GLOW_INSET}px`;
        glowCanvas.style.top = `-${COLLAGE_GLOW_INSET}px`;
        glowCanvas.style.width = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;
        glowCanvas.style.height = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;

        img.style.width = '100%';
        img.style.margin = '0';
        img.dataset.frame = 'blue-border';
        frame.appendChild(shadowCanvas);
        frame.appendChild(glowCanvas);
        frame.appendChild(img);
        return frame;
      }
      return img;
  }

  static createDomElement(el) {
    if (el.type === 'img') {
      return Renderer._createImageElement(el, false);
    } else if (el.type === 'collage') {
      const api = collageLayoutAPI();
      const collage = document.createElement('div');
      collage.className = 'card-image-collage';
      collage.style.height = `${api.normalizeHeight(el.height)}px`;
      collage.style.margin = `${STYLES.imageMargin}px auto`;
      api.normalizeItems(el.items).forEach((model) => {
        const source = el.items.find((item) => item.id === model.id) || model;
        if (!source.src) return;
        const normalizedFrame = normalizeImageFrame(source.frame);
        const item = document.createElement('div');
        item.className = 'card-collage-item';
        item.style.left = `${model.x / 100}%`;
        item.style.top = `${model.y / 100}%`;
        item.style.width = `${model.width / 100}%`;
        item.style.zIndex = String(model.z);
        if (normalizedFrame === 'blue-border') {
          const glowCanvas = document.createElement('canvas');
          glowCanvas.className = 'card-collage-glow-canvas';
          glowCanvas.setAttribute('aria-hidden', 'true');
          glowCanvas.style.left = `-${COLLAGE_GLOW_INSET}px`;
          glowCanvas.style.top = `-${COLLAGE_GLOW_INSET}px`;
          glowCanvas.style.width = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;
          glowCanvas.style.height = `calc(100% + ${COLLAGE_GLOW_INSET * 2}px)`;
          item.appendChild(glowCanvas);
        }
        item.appendChild(Renderer._createImageElement({
          src: source.src,
          width: '100%',
          frame: normalizedFrame,
          media: null,
        }, true));
        collage.appendChild(item);
      });
      return collage;
    } else if (el.type === 'empty') {
      const p = document.createElement('p');
      p.className = 'empty-line';
      return p;
    } else {
      const p = document.createElement('p');
      p.innerHTML = el.html;
      fragmentHighlights(p);
      return p;
    }
  }

  static _roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  static _paintShadowFrame(frame) {
    const img = frame.querySelector('img');
    const canvas = frame.querySelector('.card-image-shadow-canvas');
    if (!img || !canvas) return false;

    const frameRect = frame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!frameRect.width || !frameRect.height || !canvasRect.width || !canvasRect.height) return false;

    // 预览用较高像素密度避免模糊；导出时 html2canvas 还会再按 2 倍采样。
    const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(canvasRect.width * density));
    const pixelHeight = Math.max(1, Math.round(canvasRect.height * density));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, canvasRect.width, canvasRect.height);

    const x = frameRect.left - canvasRect.left;
    const y = frameRect.top - canvasRect.top;
    const drawShadow = (color, blur, offsetY) => {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = offsetY;
      // Canvas 阴影透明度还会乘以投射源透明度，因此投射源必须不透明；
      // 白色底板会被前景图片覆盖，并与当前白色卡片背景保持一致。
      ctx.fillStyle = STYLES.bgColor;
      Renderer._roundedRect(ctx, x, y, frameRect.width, frameRect.height, 10);
      ctx.fill();
      ctx.restore();
    };

    // 一层近距离接触阴影 + 一层更柔和的环境阴影，避免“硬直黑框”。
    drawShadow('rgba(20, 24, 28, 0.11)', 10, 6);
    drawShadow('rgba(20, 24, 28, 0.17)', 28, 14);
    canvas.dataset.shadowReady = 'true';
    return true;
  }

  static _paintCollageGlow(canvas) {
    const item = canvas?.closest?.('.card-collage-item, .card-image-frame-blue-border');
    if (!item) return false;
    // 使用布局尺寸而不是 getBoundingClientRect，避免桌面预览缩放后把光晕再缩一次。
    const itemWidth = item.offsetWidth;
    const itemHeight = item.offsetHeight;
    const canvasWidth = canvas.offsetWidth;
    const canvasHeight = canvas.offsetHeight;
    if (!itemWidth || !itemHeight || !canvasWidth || !canvasHeight) return false;

    const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pixelWidth = Math.max(1, Math.round(canvasWidth * density));
    const pixelHeight = Math.max(1, Math.round(canvasHeight * density));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const x = (canvasWidth - itemWidth) / 2 + 0.75;
    const y = (canvasHeight - itemHeight) / 2 + 0.75;
    const width = Math.max(1, itemWidth - 1.5);
    const height = Math.max(1, itemHeight - 1.5);
    const glowLayers = [
      { spread: 12, lineWidth: 7, color: 'rgba(64, 137, 255, 0.055)' },
      { spread: 9, lineWidth: 6, color: 'rgba(64, 137, 255, 0.08)' },
      { spread: 6, lineWidth: 5, color: 'rgba(64, 137, 255, 0.12)' },
      { spread: 3.5, lineWidth: 3.5, color: 'rgba(68, 141, 255, 0.18)' },
      { spread: 1.5, lineWidth: 2.4, color: 'rgba(72, 145, 250, 0.3)' },
      { spread: 0, lineWidth: 1.4, color: 'rgba(72, 139, 245, 0.82)' },
    ];

    // 真实的多层半透明外环不会依赖浏览器对 Canvas 阴影的实现；
    // 即使右侧预览再缩小，仍会保留一圈可见、渐弱的蓝色柔光。
    glowLayers.forEach(({ spread, lineWidth, color }) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      Renderer._roundedRect(
        ctx,
        x - spread,
        y - spread,
        width + spread * 2,
        height + spread * 2,
        5 + spread,
      );
      ctx.stroke();
      ctx.restore();
    });

    // 再补一层按 DPR 校正的环境光。投射源不透明，避免 alpha 被二次相乘后看不见。
    ctx.save();
    ctx.strokeStyle = 'rgba(68, 141, 255, 1)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(58, 131, 247, 0.32)';
    ctx.shadowBlur = 9 * density;
    Renderer._roundedRect(ctx, x, y, width, height, 5);
    ctx.stroke();
    ctx.restore();
    canvas.dataset.glowReady = 'true';
    return true;
  }

  static async prepareImageEffects(root) {
    if (!root || !root.querySelectorAll) return;
    const frames = Array.from(root.querySelectorAll('.card-image-frame-shadow, .card-image-frame-blue-border'));
    const glowCanvases = Array.from(root.querySelectorAll('.card-collage-glow-canvas'));
    if (frames.length === 0 && glowCanvases.length === 0) return;

    const images = Array.from(new Set([
      ...frames.map((frame) => frame.querySelector('img')),
      ...glowCanvases.map((canvas) => canvas.closest('.card-collage-item, .card-image-frame-blue-border')?.querySelector('img')),
    ].filter(Boolean)));
    await Promise.all(images.map((img) => {
      if (!img || img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    frames.forEach((frame) => Renderer._paintShadowFrame(frame));
    glowCanvases.forEach((canvas) => Renderer._paintCollageGlow(canvas));
  }

  static renderPreview(pages, previewArea, buildAuthorHTML) {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      Renderer._renderMobile(pages, previewArea, buildAuthorHTML);
    } else {
      Renderer._renderDesktop(pages, previewArea, buildAuthorHTML);
    }
  }

  // \u684c\u9762\u7aef\uff1a\u7ad6\u5411\u5806\u53e0\uff0c\u7b49\u6bd4\u7f29\u653e
  static _renderDesktop(pages, previewArea, buildAuthorHTML) {
    const S = STYLES;
    const scrollTop = previewArea.scrollTop;
    previewArea.innerHTML = '';

    const previewStyles = getComputedStyle(previewArea);
    const horizontalPadding = (parseFloat(previewStyles.paddingLeft) || 0) + (parseFloat(previewStyles.paddingRight) || 0);
    const availW = Math.max(1, previewArea.clientWidth - horizontalPadding);
    const scale = Math.min(1, availW / CARD_W);

    const hint = document.createElement('div');
    hint.className = 'preview-scale-hint';
    hint.textContent = `\u9884\u89c8\uff08\u5171 ${pages.length} \u9875\uff0c\u6bcf\u9875 750\u00d71000\uff09`;
    previewArea.appendChild(hint);

    pages.forEach((page, idx) => {
      if (idx > 0) {
        const div = document.createElement('div');
        div.className = 'page-divider';
        div.style.width = (CARD_W * scale) + 'px';
        div.textContent = `\u2014 \u7b2c ${idx + 1} \u9875 \u2014`;
        previewArea.appendChild(div);
      }
      const wrapper = Renderer._buildWrapper(page, buildAuthorHTML);
      wrapper.style.width = CARD_W + 'px';
      wrapper.style.marginBottom = (-(1 - scale) * CARD_H) + 'px';
      previewArea.appendChild(wrapper);
      const card = wrapper.querySelector('.card-page');
      decorateHighlightStrokes(card);
      void Renderer.prepareImageEffects(card);
      wrapper.style.transform = `scale(${scale})`;
    });
    previewArea.scrollTop = scrollTop;
  }

  // \u79fb\u52a8\u7aef\uff1a\u6a2a\u5411\u6ed1\u52a8\u8f6e\u64ad\uff0c\u6bcf\u5f20\u5360\u6ee1\u5c4f\u5e55
  static _renderMobile(pages, previewArea, buildAuthorHTML) {
    const scrollLeft = previewArea.scrollLeft;
    previewArea.innerHTML = '';

    // \u89c6\u53e3\u5c3a\u5bf8
    const vw = previewArea.clientWidth || window.innerWidth;
    const vh = previewArea.clientHeight || window.innerHeight;
    const safeTop = 56;     // \u9876\u90e8\u9884\u7559\u7ed9\u5173\u95ed\u6309\u94ae
    const safeBottom = 70;  // \u5e95\u90e8\u9884\u7559\u7ed9\u6307\u793a\u5668
    const padX = 16;
    const availW = vw - padX * 2;
    const availH = vh - safeTop - safeBottom;
    // \u53d6\u5bbd\u9ad8\u4e24\u4e2a\u7ea6\u675f\u7684\u8f83\u5c0f\u8005\uff0c\u4fdd\u6301 3:4
    const scale = Math.min(availW / CARD_W, availH / CARD_H);

    pages.forEach((page) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'preview-wrapper';

      const card = Renderer._buildCard(page, buildAuthorHTML);
      wrapper.appendChild(card);
      previewArea.appendChild(wrapper);
      decorateHighlightStrokes(card);
      void Renderer.prepareImageEffects(card);
      card.style.transform = `scale(${scale})`;
      card.style.transformOrigin = 'center center';
      // \u7528 margin \u62b5\u6d88\u7f29\u653e\u540e\u7a7a\u767d\uff0c\u8ba9 flex \u5c45\u4e2d\u6b63\u786e
      const shrinkX = (CARD_W * (1 - scale)) / 2;
      const shrinkY = (CARD_H * (1 - scale)) / 2;
      card.style.margin = `-${shrinkY}px -${shrinkX}px`;
    });

    // \u6e32\u67d3\u9875\u7801\u6307\u793a\u5668
    Renderer._renderIndicator(pages.length);

    // \u8fd8\u539f\u6eda\u52a8\u4f4d\u7f6e
    previewArea.scrollLeft = scrollLeft;
    Renderer._bindMobileScroll(previewArea);
  }

  // \u6784\u5efa\u9884\u89c8\u5305\u88c5\u5668\uff08\u684c\u9762\u7528\uff09
  static _buildWrapper(page, buildAuthorHTML) {
    const wrapper = document.createElement('div');
    wrapper.className = 'preview-wrapper';
    const card = Renderer._buildCard(page, buildAuthorHTML);
    wrapper.appendChild(card);
    return wrapper;
  }

  // \u6784\u5efa\u5361\u7247 DOM
  static _buildCard(page, buildAuthorHTML) {
    const S = STYLES;
    const card = document.createElement('div');
    card.className = 'card-page';
    card.style.paddingTop = S.paddingY + 'px';
    card.style.paddingBottom = S.paddingY + 'px';
    card.style.paddingLeft = S.paddingX + 'px';
    card.style.paddingRight = S.paddingX + 'px';
    card.style.background = S.bgColor;
    if (page.isFirst) card.innerHTML = buildAuthorHTML();

    const body = document.createElement('div');
    body.className = 'card-body';
    if (page.centerContent) body.classList.add('card-body-center');
    body.style.fontSize = S.fontSize + 'px';
    body.style.lineHeight = S.lineHeight;
    body.style.color = S.textColor;
    page.elements.forEach((el) => body.appendChild(Renderer.createDomElement(el)));
    card.appendChild(body);
    return card;
  }

  static _renderIndicator(count) {
    const indicator = document.getElementById('previewIndicator');
    if (!indicator) return;
    indicator.innerHTML = '';
    if (count <= 1) {
      indicator.classList.remove('active');
      return;
    }
    indicator.classList.add('active');
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('div');
      dot.className = 'preview-indicator-dot' + (i === 0 ? ' current' : '');
      indicator.appendChild(dot);
    }
  }

  static _bindMobileScroll(previewArea) {
    if (previewArea._scrollBound) return;
    previewArea._scrollBound = true;
    previewArea.addEventListener('scroll', () => {
      const pageWidth = previewArea.clientWidth || window.innerWidth;
      const idx = Math.round(previewArea.scrollLeft / pageWidth);
      const dots = document.querySelectorAll('#previewIndicator .preview-indicator-dot');
      dots.forEach((d, i) => d.classList.toggle('current', i === idx));
    }, { passive: true });
  }
}
