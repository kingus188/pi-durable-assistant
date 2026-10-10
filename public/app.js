    // --- 状态管理 ---
    let currentConversationId = null;
    let conversations = [];
    let conversationView = 'active';
    let pendingRemoveId = null;
    let shelfBusy = false;
    let currentEventSource = null;
    let currentViewData = null;
    let serverInfo = null;
    let previousBoots = null;
    let isComposing = false;
    let autoScrollChat = true;
    const seenUserMessageConvs = new Set();
    let conversationsInterval = null;

    // 附件与发送状态
    let pendingAttachments = [];
    let isSending = false;

    // 吉祥物状态
    let isDisconnected = false;
    let isRecovered = false;
    let recoveredUntil = 0;
    let timerTickInterval = null;

    // --- 附件校验与格式化常量 ---
    const TEXT_EXTENSIONS = new Set([
      'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
      'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
      'cs', 'rb', 'php', 'sh', 'zsh', 'bash', 'sql', 'toml', 'ini', 'conf', 'log', 'srt', 'vtt'
    ]);

    const SUPPORTED_IMAGE_MIMES = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif'
    ]);

    function formatFileSize(bytes) {
      if (bytes === null || bytes === undefined || isNaN(bytes)) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function showToast(message, type = 'info') {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
      }
      const toast = document.createElement('div');
      toast.className = `toast toast-${type} fade-in`;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('toast-fadeout');
        setTimeout(() => toast.remove(), 250);
      }, 3500);
    }

    function cleanAttachmentName(raw) {
      const name = String(raw ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>]/g, '').trim().slice(0, 100);
      return name || 'attachment';
    }

    function getFileExtension(name) {
      return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    }

    function arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)));
      }
      return btoa(binary);
    }

    async function processAttachmentFile(file) {
      const rawName = cleanAttachmentName(file.name);
      const ext = getFileExtension(rawName);
      const mime = String(file.type || '').toLowerCase().split(';')[0].trim();

      // 明确拒绝 SVG
      if (mime === 'image/svg+xml' || ext === 'svg') {
        return { error: '暂不支持这种文件，目前支持图片和文本类文件' };
      }

      const isImage = SUPPORTED_IMAGE_MIMES.has(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
      const isText = (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext));

      if (!isImage && !isText) {
        return { error: '暂不支持这种文件，目前支持图片和文本类文件' };
      }

      if (isImage) {
        const isGif = mime === 'image/gif' || ext === 'gif';
        if (isGif) {
          if (file.size > 5 * 1024 * 1024) {
            return { error: `GIF 动图「${rawName}」超过 5MB` };
          }
          const buffer = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          return {
            kind: 'image',
            name: rawName,
            mimeType: 'image/gif',
            size: file.size,
            data: base64,
            previewUrl: URL.createObjectURL(file),
          };
        }

        // JPEG / PNG / WebP：检查长边和文件大小判断是否需要压缩
        let img;
        let objUrl;
        try {
          objUrl = URL.createObjectURL(file);
          img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error(`图片「${rawName}」加载失败`));
            img.src = objUrl;
          });
        } catch (e) {
          if (objUrl) URL.revokeObjectURL(objUrl);
          return { error: e.message };
        }

        const width = img.naturalWidth;
        const height = img.naturalHeight;
        const maxDim = Math.max(width, height);
        const needCompress = maxDim > 2048 || file.size > 1.5 * 1024 * 1024;

        if (needCompress) {
          let targetWidth = width;
          let targetHeight = height;
          if (maxDim > 2048) {
            const scale = 2048 / maxDim;
            targetWidth = Math.round(width * scale);
            targetHeight = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, targetWidth, targetHeight);
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
          URL.revokeObjectURL(objUrl);

          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          const base64 = dataUrl.split(',')[1];
          const byteSize = Math.round((base64.length * 3) / 4);
          const newName = rawName.replace(/\.[^.]+$/, '') + '.jpg';

          if (byteSize > 5 * 1024 * 1024) {
            return { error: `图片「${newName}」超过 5MB` };
          }

          return {
            kind: 'image',
            name: newName,
            mimeType: 'image/jpeg',
            size: byteSize,
            data: base64,
            previewUrl: dataUrl,
          };
        } else {
          if (file.size > 5 * 1024 * 1024) {
            URL.revokeObjectURL(objUrl);
            return { error: `图片「${rawName}」超过 5MB` };
          }
          const buffer = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          const targetMime = mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
          return {
            kind: 'image',
            name: rawName,
            mimeType: targetMime,
            size: file.size,
            data: base64,
            previewUrl: objUrl,
          };
        }
      }

      // 文本类文件
      if (file.size > 200 * 1024) {
        return { error: `文本文件「${rawName}」超过 200KB` };
      }

      const buffer = await file.arrayBuffer();
      let textContent;
      try {
        textContent = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        return { error: `「${rawName}」不是 UTF-8 文本` };
      }

      if (textContent.includes('\u0000')) {
        return { error: `「${rawName}」不是文本文件` };
      }

      const base64 = arrayBufferToBase64(buffer);
      const targetMime = mime || 'text/plain';

      return {
        kind: 'text',
        name: rawName,
        mimeType: targetMime,
        size: file.size,
        data: base64,
      };
    }

    async function handleFilesSelected(fileList) {
      const files = Array.from(fileList);
      if (!files.length) return;

      if (pendingAttachments.length + files.length > 5) {
        showToast('一次最多上传 5 个附件', 'warning');
        return;
      }

      let currentTotalBytes = pendingAttachments.reduce((sum, a) => sum + (a.size || 0), 0);

      for (const file of files) {
        if (pendingAttachments.length >= 5) {
          showToast('一次最多上传 5 个附件', 'warning');
          break;
        }
        try {
          const res = await processAttachmentFile(file);
          if (res.error) {
            showToast(res.error, 'warning');
            continue;
          }
          if (currentTotalBytes + res.size > 10 * 1024 * 1024) {
            showToast('附件总大小不能超过 10MB', 'warning');
            continue;
          }
          currentTotalBytes += res.size;
          pendingAttachments.push(res);
        } catch (err) {
          showToast(err.message || '处理文件失败', 'warning');
        }
      }

      renderPendingAttachments();
      updateSendButtonState();
    }

    function removePendingAttachment(index) {
      if (index >= 0 && index < pendingAttachments.length) {
        const item = pendingAttachments[index];
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl);
        }
        pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        updateSendButtonState();
      }
    }

    function clearPendingAttachments() {
      for (const item of pendingAttachments) {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      pendingAttachments = [];
      renderPendingAttachments();
      updateSendButtonState();
    }

    function renderPendingAttachments() {
      const container = document.getElementById('attachments-preview');
      if (!container) return;

      if (pendingAttachments.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      container.style.display = 'flex';
      let html = '';
      pendingAttachments.forEach((item, index) => {
        if (item.kind === 'image') {
          html += `
            <div class="pending-chip pending-image-chip">
              <img src="${escapeHtml(item.previewUrl)}" class="pending-thumb" alt="${escapeHtml(item.name)}">
              <div class="pending-meta">
                <span class="pending-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <span class="pending-size">${escapeHtml(formatFileSize(item.size))}</span>
              </div>
              <button type="button" class="btn-remove-pending" onclick="removePendingAttachment(${index})" title="移除此附件" aria-label="移除">×</button>
            </div>
          `;
        } else {
          html += `
            <div class="pending-chip pending-text-chip">
              <span class="pending-file-icon">📄</span>
              <div class="pending-meta">
                <span class="pending-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                <span class="pending-size">${escapeHtml(formatFileSize(item.size))}</span>
              </div>
              <button type="button" class="btn-remove-pending" onclick="removePendingAttachment(${index})" title="移除此附件" aria-label="移除">×</button>
            </div>
          `;
        }
      });
      container.innerHTML = html;
    }

    function updateSendButtonState() {
      const textarea = document.getElementById('chat-textarea');
      const btnSend = document.getElementById('btn-send');
      if (!btnSend) return;

      const text = (textarea ? textarea.value : '').trim();
      const canSend = (text.length > 0 || pendingAttachments.length > 0) && !isSending;
      btnSend.disabled = !canSend;
    }

    function triggerFileInput() {
      const fileInput = document.getElementById('file-input');
      if (fileInput) {
        fileInput.value = '';
        fileInput.click();
      }
    }

    function setupDragAndDrop() {
      const chatColumn = document.querySelector('.chat-column');
      const dropOverlay = document.getElementById('drop-overlay');
      if (!chatColumn || !dropOverlay) return;

      let dragCounter = 0;

      chatColumn.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.types && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.contains('Files'))) {
          dragCounter++;
          dropOverlay.style.display = 'flex';
        }
      });

      chatColumn.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      });

      chatColumn.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          dropOverlay.style.display = 'none';
        }
      });

      chatColumn.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.style.display = 'none';
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          await handleFilesSelected(e.dataTransfer.files);
        }
      });
    }

    // --- 小 D 矢量图形模版 ---
    const ROBOT_SVG_CONTENT = `
      <g>
        <!-- 烟雾（断线冒烟） -->
        <g class="d-smoke">
          <circle cx="44" cy="10" r="4.5" fill="#94a3b8" />
          <circle cx="56" cy="7" r="5.5" fill="#cbd5e1" />
          <circle cx="50" cy="3" r="3.5" fill="#64748b" />
        </g>

        <!-- Zzz（等待打瞌睡） -->
        <g class="d-zzz">
          <text x="68" y="24" font-size="11" font-weight="bold" fill="var(--primary)" font-family="sans-serif">Z</text>
          <text x="78" y="16" font-size="9" font-weight="bold" fill="var(--primary)" font-family="sans-serif">z</text>
        </g>

        <!-- 思考波纹（思考中） -->
        <circle cx="50" cy="13" r="10" stroke="var(--purple)" stroke-width="1.5" stroke-dasharray="4 2" fill="none" class="d-wave-pulse" />

        <!-- 天线 -->
        <line x1="50" y1="15" x2="50" y2="25" stroke="#6366f1" stroke-width="3" stroke-linecap="round" />
        <circle cx="50" cy="13" r="4.5" fill="#f59e0b" class="d-antenna-tip" />

        <!-- 左右耳 -->
        <rect x="19" y="38" width="6" height="14" rx="3" fill="#6366f1" />
        <rect x="75" y="38" width="6" height="14" rx="3" fill="#6366f1" />

        <!-- 脑袋外框 -->
        <rect x="23" y="25" width="54" height="42" rx="14" fill="#4f46e5" />
        <!-- 面部深色视窗屏 -->
        <rect x="29" y="31" width="42" height="30" rx="8" fill="#1e1b4b" />

        <!-- 1. 空闲表情（眨眼微笑） -->
        <g class="d-expr-idle">
          <rect x="36" y="39" width="6" height="11" rx="3" fill="#38bdf8" class="d-eye-blink" />
          <rect x="58" y="39" width="6" height="11" rx="3" fill="#38bdf8" class="d-eye-blink" />
          <path d="M46 52 Q50 55 54 52" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" fill="none" />
        </g>

        <!-- 2. 断线表情（× 眼睛，波浪哭嘴） -->
        <g class="d-expr-disconnected">
          <path d="M36 40 L42 48 M42 40 L36 48" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" />
          <path d="M58 40 L64 48 M64 40 L58 48" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" />
          <path d="M46 54 Q50 51 54 54" stroke="#ef4444" stroke-width="2" stroke-linecap="round" fill="none" />
        </g>

        <!-- 3. 刚恢复表情（星星眼，开怀大笑） -->
        <g class="d-expr-recovered">
          <polygon points="39,38 40.5,42.5 45,43 41.5,46 42.5,50.5 39,48 35.5,50.5 36.5,46 33,43 37.5,42.5" fill="#facc15" />
          <polygon points="61,38 62.5,42.5 67,43 63.5,46 64.5,50.5 61,48 57.5,50.5 58.5,46 55,43 59.5,42.5" fill="#facc15" />
          <path d="M45 51 Q50 57 55 51 Z" fill="#facc15" />
        </g>

        <!-- 4. 等待打瞌睡表情（弯弯睡眼，小嘴） -->
        <g class="d-expr-waiting">
          <path d="M35 45 Q39 40 43 45" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" fill="none" />
          <path d="M57 45 Q61 40 65 45" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" fill="none" />
          <ellipse cx="50" cy="52" rx="2.5" ry="1.8" fill="#94a3b8" />
        </g>

        <!-- 5. 用工具表情（坚定眼神） -->
        <g class="d-expr-tool">
          <circle cx="39" cy="44" r="4.5" fill="#38bdf8" />
          <circle cx="61" cy="44" r="4.5" fill="#38bdf8" />
          <path d="M46 52 L54 52" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" />
        </g>

        <!-- 6. 思考中表情（旋转圈圈眼） -->
        <g class="d-expr-thinking">
          <circle cx="39" cy="44" r="5" stroke="#a855f7" stroke-width="2.5" stroke-dasharray="8 4" fill="none" class="d-eye-spin" />
          <circle cx="61" cy="44" r="5" stroke="#a855f7" stroke-width="2.5" stroke-dasharray="8 4" fill="none" class="d-eye-spin" />
          <path d="M47 52 Q50 50 53 52" stroke="#a855f7" stroke-width="2" stroke-linecap="round" fill="none" />
        </g>

        <!-- 7. 有提醒表情（开心圆眼，抱闹钟） -->
        <g class="d-expr-reminder">
          <path d="M35 45 Q39 39 43 45" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" fill="none" />
          <path d="M57 45 Q61 39 65 45" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" fill="none" />
          <path d="M46 52 Q50 55 54 52" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" fill="none" />
        </g>

        <!-- 8. 出错表情（难过眼睛，委屈瘪嘴，眼角带泪光） -->
        <g class="d-expr-error">
          <path d="M35 39 L42 42" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" />
          <path d="M65 39 L58 42" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" />
          <ellipse cx="39" cy="45" rx="3.5" ry="4" fill="#38bdf8" />
          <ellipse cx="61" cy="45" rx="3.5" ry="4" fill="#38bdf8" />
          <circle cx="40" cy="44" r="1.2" fill="#ffffff" />
          <circle cx="62" cy="44" r="1.2" fill="#ffffff" />
          <path d="M46 53 Q50 49 54 53" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" fill="none" />
          <circle cx="35" cy="50" r="1.5" fill="#38bdf8" />
        </g>

        <!-- 身体躯干 -->
        <rect x="33" y="68" width="34" height="24" rx="8" fill="#6366f1" />
        <rect x="42" y="74" width="16" height="12" rx="4" fill="#4338ca" />
        <circle cx="50" cy="80" r="3" fill="#38bdf8" />

        <!-- 左臂 -->
        <path d="M32 72 Q24 78 24 86" stroke="#6366f1" stroke-width="5" stroke-linecap="round" fill="none" />

        <!-- 右臂（正常） -->
        <path d="M68 72 Q76 78 76 86" stroke="#6366f1" stroke-width="5" stroke-linecap="round" fill="none" class="d-normal-arm" />

        <!-- 工具道具（举扳手） -->
        <g class="d-prop-tool">
          <g class="d-arm-wrench">
            <path d="M68 72 Q78 66 82 54" stroke="#6366f1" stroke-width="5.5" stroke-linecap="round" fill="none" />
            <path d="M82 54 L90 46 M87 43 A4 4 0 1 1 93 49" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" fill="none" />
          </g>
        </g>

        <!-- 闹钟道具（抱着小闹钟） -->
        <g class="d-prop-clock">
          <g class="d-clock-accessory">
            <circle cx="12" cy="12" r="10" fill="#fef3c7" stroke="#d97706" stroke-width="2" />
            <path d="M6 3 L9 6 M18 3 L15 6" stroke="#d97706" stroke-width="2" stroke-linecap="round" />
            <path d="M12 7 L12 12 L15 12" stroke="#92400e" stroke-width="1.5" stroke-linecap="round" />
          </g>
        </g>

        <!-- 底座轮轴 -->
        <rect x="37" y="93" width="26" height="6" rx="3" fill="#312e81" />
      </g>
    `;

    // 初始化内联 SVG
    function setupMascotSvgs() {
      const desktopSvg = document.getElementById('mascot-svg');
      const mobileSvg = document.getElementById('mobile-mascot-svg');
      if (desktopSvg) desktopSvg.innerHTML = ROBOT_SVG_CONTENT;
      if (mobileSvg) mobileSvg.innerHTML = ROBOT_SVG_CONTENT;
    }

    // --- 工具函数 ---
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ---- 增量渲染：只替换内容变了的子节点，没变的原样保留 ----
    // 每次推送都整块重建会让淡入动画重放、滚动和展开状态丢失，看起来就是闪烁
    function patchChildren(target, staging) {
      const next = Array.from(staging.children);
      const prev = Array.from(target.children);
      next.forEach((node, i) => {
        node.__sig = node.outerHTML;
        const old = prev[i];
        if (old && old.__sig === node.__sig) return;
        // 同一位置的更新（比如工具结果到达、流式文字增长）不再播放入场动画
        if (old) {
          node.classList.add('no-anim');
          target.replaceChild(node, old);
        } else {
          target.appendChild(node);
        }
      });
      for (let i = next.length; i < prev.length; i++) prev[i].remove();
    }

    // 面板渲染函数先画到离屏节点，微任务里统一打补丁到页面
    const pendingPatches = [];
    function stagingFor(id) {
      const real = document.getElementById(id);
      if (!real) return null;
      const staging = document.createElement(real.tagName);
      if (pendingPatches.length === 0) queueMicrotask(flushPatches);
      pendingPatches.push([real, staging]);
      return staging;
    }
    function flushPatches() {
      for (const [real, staging] of pendingPatches.splice(0)) patchChildren(real, staging);
    }

    // ---- 极简 Markdown 渲染：先整体转义，再加格式，不信任模型输出的任何 HTML ----
    function renderInlineMarkdown(text) {
      const codes = [];
      let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
        codes.push(c);
        return '\u0000' + (codes.length - 1) + '\u0000';
      });
      out = out
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
      return out.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
    }

    function renderMarkdown(src) {
      const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
      const html = [];
      let para = [];
      const flushPara = () => {
        if (para.length) html.push('<p>' + para.map(renderInlineMarkdown).join('<br>') + '</p>');
        para = [];
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^\s*```(\S*)\s*$/);
        if (fence) {
          flushPara();
          const body = [];
          for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
          html.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
          continue;
        }
        if (!line.trim()) { flushPara(); continue; }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          flushPara();
          const level = Math.min(6, heading[1].length + 2);
          html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
          continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); html.push('<hr>'); continue; }
        // 表格：| a | b | 下一行是 |---|---|
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
          flushPara();
          const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => renderInlineMarkdown(c.trim()));
          const head = cells(line);
          const rows = [];
          for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
          i--;
          html.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
          continue;
        }
        const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (list) {
          flushPara();
          const ordered = /\d/.test(list[1]);
          const items = [];
          for (; i < lines.length; i++) {
            const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
            if (!m || /\d/.test(m[1]) !== ordered) break;
            items.push(m[2]);
          }
          i--;
          const tag = ordered ? 'ol' : 'ul';
          html.push(`<${tag}>` + items.map((t) => `<li>${renderInlineMarkdown(t)}</li>`).join('') + `</${tag}>`);
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          flushPara();
          const quote = [];
          for (; i < lines.length && /^\s*>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i--;
          html.push('<blockquote>' + quote.map(renderInlineMarkdown).join('<br>') + '</blockquote>');
          continue;
        }
        para.push(line);
      }
      flushPara();
      return html.join('');
    }

    function generateUuid() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function formatTime(timestamp) {
      if (!timestamp) return '-';
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return String(timestamp);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function formatShortTime(timestamp) {
      if (!timestamp) return '';
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function formatListTime(timestamp) {
      if (!timestamp) return '';
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const now = new Date();
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const dayDiff = Math.round((startToday - startThat) / 86400000);
      if (dayDiff === 0) return `今天 ${hm}`;
      if (dayDiff === 1) return `昨天 ${hm}`;
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function formatDuration(ms) {
      if (ms <= 0) return '0 秒';
      const totalSec = Math.floor(ms / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      if (mins > 0) {
        return `${mins} 分 ${secs} 秒`;
      }
      return `${secs} 秒`;
    }

    function formatToolArgs(args) {
      if (!args) return '(无参数)';
      if (typeof args === 'string') return args;
      if (typeof args !== 'object') return String(args);
      const entries = Object.entries(args);
      if (entries.length === 0) return '(无参数)';
      return entries
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' · ');
    }

    function getLastNonEmptyLine(output) {
      if (!output || typeof output !== 'string') return '';
      const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      return lines.length > 0 ? lines[lines.length - 1] : '';
    }

    function formatUsageTokens(usage) {
      if (!usage) return '0';
      if (usage.models) {
        const all = Object.values(usage.models);
        usage = {
          input: all.reduce((n, u) => n + (u.input || 0), 0),
          output: all.reduce((n, u) => n + (u.output || 0), 0),
        };
      }
      const input = usage.input || usage.inputTokens || 0;
      const output = usage.output || usage.outputTokens || 0;
      const total = usage.totalTokens || (input + output);
      if (input || output) {
        return `入 ${input} · 出 ${output}`;
      }
      return `${total}`;
    }

    // --- 断线重连横条控制 ---
    const reconnectBanner = document.getElementById('reconnect-banner');
    function showReconnectBanner() {
      isDisconnected = true;
      reconnectBanner.style.display = 'flex';
      updateMascotState();
    }
    function hideReconnectBanner() {
      isDisconnected = false;
      reconnectBanner.style.display = 'none';
      updateMascotState();
    }

    // --- API 调用 ---
    async function fetchServerInfo() {
      try {
        const res = await fetch('/api/info');
        if (!res.ok) throw new Error('拉取服务信息失败');
        const data = await res.json();
        updateServerInfo(data);
      } catch (err) {
        console.warn('拉取 /api/info 失败:', err);
      }
    }

    function updateServerInfo(info) {
      serverInfo = info;
      const pidEl = document.getElementById('stat-pid');
      const timeEl = document.getElementById('stat-started-at');
      const bootsEl = document.getElementById('stat-boots');
      const modelEl = document.getElementById('stat-model');

      if (pidEl) pidEl.textContent = info.pid || '-';
      if (timeEl) timeEl.textContent = formatTime(info.startedAt);
      if (modelEl) modelEl.textContent = info.model || info.api || '-';

      if (bootsEl && info.boots !== undefined) {
        bootsEl.textContent = `第 ${info.boots} 次启动`;
        // 若启动次数变大，说明经历过重启恢复
        if (previousBoots !== null && info.boots > previousBoots) {
          bootsEl.classList.remove('boots-updated');
          void bootsEl.offsetWidth; // 触发 reflow
          bootsEl.classList.add('boots-updated');

          // 触发小 D “刚恢复”状态（持续 4 秒）
          isRecovered = true;
          recoveredUntil = Date.now() + 4000;
          setTimeout(() => {
            if (Date.now() >= recoveredUntil) {
              isRecovered = false;
              updateMascotState();
            }
          }, 4050);
        }
        previousBoots = info.boots;
      }

      updateMascotState();
    }

    async function fetchConversations(isInitial = false) {
      try {
        const res = await fetch('/api/conversations');
        if (!res.ok) throw new Error('拉取会话列表失败');
        conversations = await res.json();
        if (pendingRemoveId && !conversations.some((c) => String(c.id) === pendingRemoveId)) pendingRemoveId = null;

        // 只在第一次进入时自动打开。之后用户把当前对话清空，10 秒刷新不能再偷偷建一条。
        if (isInitial) {
          const hashId = parseHashConversationId();
          if (hashId !== null) {
            const hashed = conversations.find((c) => String(c.id) === String(hashId));
            if (hashed?.archivedAt) conversationView = 'archived';
            renderConversationList();
            updateConversationHeaders();
            if (String(currentConversationId) !== String(hashId)) selectConversation(hashId);
            return true;
          }
          const firstActive = conversations.find((c) => !c.archivedAt);
          if (firstActive) {
            renderConversationList();
            updateConversationHeaders();
            selectConversation(firstActive.id);
            return true;
          }
          if (conversations.length === 0) {
            await createNewConversation();
            return true;
          }
          conversationView = 'active';
          renderConversationList();
          updateConversationHeaders();
          clearOpenConversation();
          return true;
        }

        renderConversationList();
        updateConversationHeaders();
        return true;
      } catch (err) {
        console.error('拉取会话列表出错:', err);
        return false;
      }
    }

    function parseHashConversationId() {
      const hash = window.location.hash.replace(/^#/, '').trim();
      if (!hash) return null;
      return hash;
    }

    async function createNewConversation() {
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('新建会话失败');
        const data = await res.json();
        conversationView = 'active';
        pendingRemoveId = null;
        closeSidebarDrawer();
        selectConversation(data.id);
        await fetchConversations();
      } catch (err) {
        alert('新建会话失败：' + err.message);
      }
    }

    function selectConversation(id) {
      if (String(currentConversationId) === String(id) && currentEventSource) {
        return;
      }
      currentConversationId = id;
      window.location.hash = '#' + id;
      renderConversationList();
      updateConversationHeaders();
      connectSse(id);
    }

    function updateConversationHeaders() {
      const current = conversations.find(c => String(c.id) === String(currentConversationId));
      let title = currentConversationId ? '新对话' : '未选择对话';
      if (current) {
        title = current.forkOf ? `⑂ ${current.title}` : current.title;
      } else if (currentViewData && currentViewData.parentId) {
        title = `子 Agent 会话 #${currentConversationId}`;
      }
      const desktopTitleEl = document.getElementById('desktop-current-title');
      const mobileTitleEl = document.getElementById('mobile-current-title');
      const desktopMetaEl = document.getElementById('desktop-current-meta');

      if (desktopTitleEl) desktopTitleEl.textContent = title;
      if (mobileTitleEl) mobileTitleEl.textContent = title;
      if (desktopMetaEl) {
        desktopMetaEl.textContent = current?.createdAt ? formatTime(current.createdAt) : '';
      }
    }

    function setConversationView(view) {
      conversationView = view === 'archived' ? 'archived' : 'active';
      pendingRemoveId = null;
      renderConversationList();
    }

    function syncConversationTabs() {
      const activeCount = conversations.filter((c) => !c.archivedAt).length;
      const archivedCount = conversations.length - activeCount;
      const activeBtn = document.getElementById('conv-tab-active');
      const archivedBtn = document.getElementById('conv-tab-archived');
      const activeNum = document.getElementById('conv-count-active');
      const archivedNum = document.getElementById('conv-count-archived');
      if (activeNum) activeNum.textContent = String(activeCount);
      if (archivedNum) archivedNum.textContent = String(archivedCount);
      const archivedOn = conversationView === 'archived';
      if (activeBtn) {
        activeBtn.classList.toggle('is-on', !archivedOn);
        activeBtn.setAttribute('aria-selected', archivedOn ? 'false' : 'true');
      }
      if (archivedBtn) {
        archivedBtn.classList.toggle('is-on', archivedOn);
        archivedBtn.setAttribute('aria-selected', archivedOn ? 'true' : 'false');
      }
      return { activeCount, archivedCount };
    }

    function makeConvButton(action, label, title, danger) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'conv-action' + (danger ? ' conv-action-danger' : '');
      button.dataset.action = action;
      button.textContent = label;
      if (title) button.title = title;
      return button;
    }

    function renderConversationList() {
      const listEl = stagingFor('conversation-list');
      const { archivedCount } = syncConversationTabs();
      if (!listEl) return;
      const archivedOn = conversationView === 'archived';
      const realList = document.getElementById('conversation-list');
      if (realList) realList.classList.toggle('is-archived-view', archivedOn);
      const visible = conversations.filter((c) => archivedOn ? !!c.archivedAt : !c.archivedAt);

      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'conv-empty';
        empty.textContent = archivedOn
          ? '还没有归档的对话。'
          : (archivedCount > 0 ? `当前没有对话。归档里还有 ${archivedCount} 个。` : '当前没有对话。');
        listEl.appendChild(empty);
        return;
      }

      visible.forEach((c) => {
        const item = document.createElement('article');
        const isActive = String(c.id) === String(currentConversationId);
        const confirming = pendingRemoveId === String(c.id);
        item.className = 'conversation-item' + (isActive ? ' active' : '') + (confirming ? ' is-confirming' : '');
        item.dataset.id = String(c.id);

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'conv-open';
        open.dataset.action = 'open';
        const titleRow = document.createElement('span');
        titleRow.className = 'conv-title-row';
        const isFork = !!c.forkOf || (c.title && c.title.startsWith('分叉'));
        if (isFork) {
          const fork = document.createElement('span');
          fork.className = 'conv-fork-icon';
          fork.textContent = '⑂';
          titleRow.appendChild(fork);
        }
        const title = document.createElement('span');
        title.className = 'conv-title';
        title.textContent = c.title || '新对话';
        titleRow.appendChild(title);
        const stamp = archivedOn ? (c.archivedAt || c.createdAt) : c.createdAt;
        const time = document.createElement('span');
        time.className = 'conv-time';
        time.textContent = formatListTime(stamp);
        time.title = formatTime(stamp);
        open.appendChild(titleRow);
        open.appendChild(time);
        item.appendChild(open);

        if (confirming) {
          const confirm = document.createElement('div');
          confirm.className = 'conv-confirm';
          const note = document.createElement('p');
          note.textContent = '只从列表移除，本机记录还在。确定？';
          const actions = document.createElement('div');
          actions.className = 'conv-actions';
          actions.appendChild(makeConvButton('cancel-remove', '取消', '留在列表里'));
          actions.appendChild(makeConvButton('confirm-remove', '删除', '只从列表移除，本机记录还在', true));
          confirm.appendChild(note);
          confirm.appendChild(actions);
          item.appendChild(confirm);
        } else {
          const actions = document.createElement('div');
          actions.className = 'conv-actions';
          if (archivedOn) {
            actions.appendChild(makeConvButton('restore', '恢复', '放回当前列表。已停掉的提醒和计划不会自动恢复。'));
          } else {
            actions.appendChild(makeConvButton('archive', '归档', '从当前列表收起，并停掉未完成的提醒和计划'));
          }
          actions.appendChild(makeConvButton('remove', '删除', '只从列表移除，本机记录还在', true));
          item.appendChild(actions);
        }
        listEl.appendChild(item);
      });
    }

    async function postShelf(id, action) {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '操作失败');
      return body;
    }

    function clearOpenConversation() {
      const es = currentEventSource;
      currentEventSource = null;
      if (es) es.close();
      currentConversationId = null;
      currentViewData = null;
      if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      updateConversationHeaders();
      const chatEl = document.getElementById('messages-container');
      if (chatEl) {
        const container = document.createElement('div');
        renderEmptyConversation(container);
        patchChildren(chatEl, container);
      }
      renderNotes({ todos: [], memos: [] });
      renderReminders([]);
      renderTasks([]);
      updateBusyControls(false, 0);
      renderConversationList();
    }

    async function runShelf(id, action) {
      if (shelfBusy) return;
      shelfBusy = true;
      const wasCurrent = String(currentConversationId) === String(id);
      try {
        const result = await postShelf(id, action);
        pendingRemoveId = null;
        if (action === 'remove') {
          conversations = conversations.filter((c) => String(c.id) !== String(id));
        } else {
          const item = conversations.find((c) => String(c.id) === String(id));
          if (item) item.archivedAt = result.archivedAt ?? null;
        }
        if (action === 'restore' && wasCurrent) conversationView = 'active';
        renderConversationList();
        await fetchConversations();
        if (wasCurrent && action !== 'restore') {
          const next = conversations.find((c) => !c.archivedAt);
          if (next) selectConversation(next.id);
          else clearOpenConversation();
        }
      } catch (err) {
        showToast(err.message || '操作失败', 'warning');
      } finally {
        shelfBusy = false;
      }
    }

    function handleConversationAction(id, action) {
      if (!id) return;
      if (action === 'open') {
        selectConversation(id);
        closeSidebarDrawer();
        return;
      }
      if (action === 'remove') {
        pendingRemoveId = String(id);
        renderConversationList();
        return;
      }
      if (action === 'cancel-remove') {
        pendingRemoveId = null;
        renderConversationList();
        return;
      }
      if (action === 'confirm-remove') {
        void runShelf(id, 'remove');
        return;
      }
      if (action === 'archive' || action === 'restore') void runShelf(id, action);
    }

    function onConversationListClick(e) {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl || !e.currentTarget.contains(actionEl)) return;
      const item = actionEl.closest('.conversation-item');
      if (!item) return;
      handleConversationAction(item.dataset.id, actionEl.dataset.action);
    }

    // --- SSE 连接与数据渲染 ---
    function connectSse(conversationId) {
      if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
      }

      const url = `/api/conversations/${encodeURIComponent(conversationId)}/events`;
      const es = new EventSource(url);
      currentEventSource = es;

      es.onopen = () => {
        hideReconnectBanner();
        fetchServerInfo();
        fetchConversations();
      };

      es.onerror = () => {
        // 切换会话时旧连接被关掉，也会触发 error。那不是断线。
        if (currentEventSource !== es) return;
        showReconnectBanner();
      };

      es.addEventListener('view', (e) => {
        try {
          const data = JSON.parse(e.data);
          currentViewData = data;
          renderView(data);
        } catch (err) {
          console.error('解析 SSE view 数据失败:', err);
        }
      });
    }

    // 解析 live 状态
    function extractLiveInfo(live) {
      if (!live) return null;
      if (!window.__liveLogged && Object.keys(live).length) {
        window.__liveLogged = true;
        console.log('pi.live 实时结构:', live);
      }

      let text = '';
      let thinking = '';
      const runningTools = [];

      if (live.generation && live.generation.message) {
        const msg = live.generation.message;
        const contents = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : []);
        for (const item of contents) {
          if (typeof item === 'string') {
            text += item;
          } else if (item && typeof item === 'object') {
            if (item.type === 'text' && item.text) {
              text += item.text;
            } else if (item.type === 'thinking' && item.thinking) {
              thinking += item.thinking;
            } else if (item.type === 'toolCall') {
              runningTools.push({
                name: item.name || '工具调用',
                args: item.arguments || item.args,
                status: 'running'
              });
            }
          }
        }
      }

      if (!text && typeof live.text === 'string') text = live.text;
      if (!text && typeof live.generation?.text === 'string') text = live.generation.text;
      if (!text && typeof live.stream === 'string') text = live.stream;

      if (Array.isArray(live.tools)) {
        for (const slot of live.tools) {
          runningTools.push({
            name: slot.name || '工具',
            callId: slot.callId,
            status: slot.status || 'running',
            output: slot.output || '',
            args: slot.args,
            details: slot.details
          });
        }
      }

      return {
        text: text.trim(),
        thinking: thinking.trim(),
        runningTools
      };
    }

    // =========================================================
    // 吉祥物“小 D”状态机（严格按优先级判定）
    // =========================================================
    const TOOL_NAME_MAP = {
      'fetch_page': '正在看网页……',
      'wait_seconds': '等待中……',
      'todo': '正在记待办……',
      'memo': '正在记备忘……',
      'remind_me': '正在定闹钟……',
      'delegate': '正在派子 Agent……',
      'current_time': '正在看时间……'
    };

    function updateMascotState() {
      const mascotCard = document.getElementById('mascot-card');
      const mobileMascot = document.getElementById('mobile-mascot');
      const textEl = document.getElementById('mascot-text');
      const mobileTextEl = document.getElementById('mobile-mascot-text');
      const tagEl = document.getElementById('mascot-status-tag');
      if (!mascotCard) return;

      let state = 'idle';
      let bubbleText = '有事叫我～';
      let tagText = '空闲中';

      const view = currentViewData;
      const liveInfo = view ? extractLiveInfo(view.live) : null;
      const runningTools = liveInfo ? liveInfo.runningTools : [];
      const hasWaitSeconds = runningTools.some(t => t.name === 'wait_seconds' || t.name === '等待');
      const otherRunningTool = runningTools.find(t => t.name !== 'wait_seconds' && t.name !== '等待');
      const isBusy = view ? (!!view.busy || (view.live && Object.keys(view.live).length > 0)) : false;

      // 检查当前会话最后一条消息是否为错误（忽略没有 text、没有 toolCalls、也没有 error 的无效 assistant 条目）
      const renderableEntries = (view && Array.isArray(view.entries))
        ? view.entries.filter(e => {
            if (e.kind === 'assistant') {
              const hasText = !!(e.text && e.text.trim());
              const hasToolCalls = Array.isArray(e.toolCalls) && e.toolCalls.length > 0;
              const hasError = !!e.error;
              return hasText || hasToolCalls || hasError;
            }
            return true;
          })
        : [];
      const lastEntry = renderableEntries.length > 0 ? renderableEntries[renderableEntries.length - 1] : null;
      const isLastError = !!(lastEntry && lastEntry.kind === 'assistant' && lastEntry.error);

      // 1. 断线（优先级最高）
      if (isDisconnected) {
        state = 'disconnected';
        bubbleText = '我挂了……等我一下';
        tagText = '断线中';
      }
      // 2. 刚恢复（持续 4 秒）
      else if (isRecovered && Date.now() < recoveredUntil) {
        state = 'recovered';
        const bootsNum = serverInfo?.boots || previousBoots || 1;
        bubbleText = `我回来了！第 ${bootsNum} 次启动，接着干`;
        tagText = '刚恢复';
      }
      // 3. 等待中（live.tools 里有 wait_seconds 在跑）
      else if (hasWaitSeconds) {
        state = 'waiting';
        const waitTool = runningTools.find(t => t.name === 'wait_seconds' || t.name === '等待');
        let remainStr = '';
        if (waitTool && waitTool.output) {
          const lastLine = getLastNonEmptyLine(waitTool.output);
          const match = lastLine.match(/还剩\s*(\d+)\s*秒/);
          if (match) remainStr = `还剩 ${match[1]} 秒`;
        }
        if (!remainStr && waitTool && waitTool.args && waitTool.args.seconds) {
          remainStr = `还剩 ${waitTool.args.seconds} 秒`;
        }
        bubbleText = remainStr ? `小睡一下，${remainStr}` : '小睡一下，还剩 12 秒';
        tagText = '等待中';
      }
      // 4. 用工具（live.tools 里有其他工具在跑）
      else if (otherRunningTool) {
        state = 'tool';
        const name = otherRunningTool.name;
        bubbleText = TOOL_NAME_MAP[name] || `正在使用 ${name}……`;
        tagText = '调用工具';
      }
      // 5. 思考中（busy 且没有工具在跑）
      else if (isBusy) {
        state = 'thinking';
        bubbleText = '思考中……';
        tagText = '思考中';
      }
      // 6. 出错（当前会话最后一条是错误、且不忙时）
      else if (isLastError) {
        state = 'error';
        bubbleText = '模型那边出错了……';
        tagText = '出错';
      }
      // 7. 有提醒（空闲且有 scheduled 提醒）
      else if (view && Array.isArray(view.reminders) && view.reminders.some(r => r.status === 'scheduled')) {
        const scheduled = view.reminders.filter(r => r.status === 'scheduled');
        scheduled.sort((a, b) => a.at - b.at);
        const earliest = scheduled[0];
        const diff = earliest.at - Date.now();
        state = 'reminder';
        if (diff > 0) {
          bubbleText = `${formatDuration(diff)}后提醒你${earliest.text}`;
        } else {
          bubbleText = `即将提醒你${earliest.text}`;
        }
        tagText = '有提醒';
      }
      // 8. 空闲（默认 fallback）
      else {
        state = 'idle';
        bubbleText = '有事叫我～';
        tagText = '空闲中';
      }

      // 应用状态属性与文案
      mascotCard.setAttribute('data-state', state);
      if (mobileMascot) mobileMascot.setAttribute('data-state', state);
      if (textEl) textEl.textContent = bubbleText;
      if (mobileTextEl) mobileTextEl.textContent = bubbleText;
      if (tagEl) tagEl.textContent = tagText;
    }

    // --- 移动端小 D 气泡弹窗切换 ---
    function toggleMobileMascotBubble(e) {
      if (e) e.stopPropagation();
      const popup = document.getElementById('mobile-mascot-popup');
      if (popup) {
        popup.classList.toggle('show');
      }
    }

    document.addEventListener('click', (e) => {
      const popup = document.getElementById('mobile-mascot-popup');
      const mobileMascot = document.getElementById('mobile-mascot');
      if (popup && popup.classList.contains('show')) {
        if (!mobileMascot || !mobileMascot.contains(e.target)) {
          popup.classList.remove('show');
        }
      }
    });

    // =========================================================
    // 渲染主函数
    // =========================================================
    function renderView(view) {
      const chatEl = document.getElementById('messages-container');
      if (!chatEl) return;
      // 先画到离屏节点，最后只把变化补到页面上
      const container = document.createElement('div');

      const isNearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;

      // 1. 处理子 Agent 会话顶部提示
      const parentBanner = document.getElementById('subagent-parent-banner');
      if (parentBanner) {
        if (view.parentId) {
          parentBanner.style.display = 'flex';
          const link = document.getElementById('subagent-back-link');
          if (link) link.setAttribute('data-parent-id', view.parentId);
        } else {
          parentBanner.style.display = 'none';
        }
      }

      // 2. 空会话：显示 4 个示例引导按钮
      const hasRenderableEntries = Array.isArray(view.entries) && view.entries.some(e => {
        if (e.kind === 'assistant') {
          const hasText = !!(e.text && e.text.trim());
          const hasToolCalls = Array.isArray(e.toolCalls) && e.toolCalls.length > 0;
          const hasError = !!e.error;
          return hasText || hasToolCalls || hasError;
        }
        if (e.kind === 'user') {
          const hasText = !!(e.text && e.text.trim());
          const hasAttachments = Array.isArray(e.attachments) && e.attachments.length > 0;
          return hasText || hasAttachments;
        }
        return true;
      });
      const isBusy = !!view.busy || (view.live && Object.keys(view.live).length > 0);

      if (!hasRenderableEntries && !isBusy) {
        renderEmptyConversation(container);
      }

      // 5. 会话列表标题刷新：当前会话的 view 里第一次出现 user 消息时拉取
      const hasUserMsg = Array.isArray(view.entries) && view.entries.some(e => e.kind === 'user');
      if (hasUserMsg && currentConversationId && !seenUserMessageConvs.has(String(currentConversationId))) {
        seenUserMessageConvs.add(String(currentConversationId));
        fetchConversations();
      }

      // 建立工具执行结果映射
      const toolResultsMap = new Map();
      if (Array.isArray(view.entries)) {
        for (const entry of view.entries) {
          if (entry.kind === 'tool' && entry.toolCallId) {
            toolResultsMap.set(String(entry.toolCallId), entry);
          }
        }
      }

      // 建立 live 工具运行槽映射 (按 callId 索引)
      const liveToolsMap = new Map();
      if (view.live && Array.isArray(view.live.tools)) {
        for (const slot of view.live.tools) {
          if (slot && slot.callId) {
            liveToolsMap.set(String(slot.callId), slot);
          }
        }
      }

      const renderedToolCallIds = new Set();

      // 3. 渲染历史 Entry
      if (Array.isArray(view.entries)) {
        for (let i = 0; i < view.entries.length; i++) {
          const entry = view.entries[i];
          if (entry.kind === 'user') {
            const rawText = entry.text || '';
            // 以 [定时提醒] 开头的用户消息：显示为居中的 ⏰ 提醒系统卡片
            if (rawText.startsWith('[定时提醒]')) {
              const row = document.createElement('div');
              row.className = 'message-row reminder-system-row';
              const cleanText = rawText.replace(/^\[定时提醒\]\s*/, '');
              row.innerHTML = `
                <div class="reminder-system-card">
                  <span class="reminder-system-icon">⏰</span>
                  <div class="reminder-system-text">${escapeHtml(cleanText)}</div>
                </div>
              `;
              container.appendChild(row);
            } else {
              // 普通用户消息
              const hasAttachments = Array.isArray(entry.attachments) && entry.attachments.length > 0;
              const hasText = !!(rawText && rawText.trim());

              let attachmentsHtml = '';
              if (hasAttachments) {
                attachmentsHtml = '<div class="user-attachments-grid">';
                for (const att of entry.attachments) {
                  if (att.kind === 'image' && att.url) {
                    attachmentsHtml += `
                      <a href="${escapeHtml(att.url)}" target="_blank" rel="noopener noreferrer" class="msg-image-link" title="点击查看大图：${escapeHtml(att.name)}">
                        <img class="msg-image-thumb" src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name)}" loading="lazy">
                      </a>
                    `;
                  } else {
                    attachmentsHtml += `
                      <div class="msg-file-card" title="${escapeHtml(att.name)}">
                        <span class="msg-file-icon">📄</span>
                        <div class="msg-file-details">
                          <span class="msg-file-name">${escapeHtml(att.name)}</span>
                          <span class="msg-file-size">${escapeHtml(formatFileSize(att.size || 0))}</span>
                        </div>
                      </div>
                    `;
                  }
                }
                attachmentsHtml += '</div>';
              }

              const row = document.createElement('div');
              row.className = 'message-row user-row';
              row.innerHTML = `
                <button class="fork-btn" title="从这里分叉" onclick="forkConversation('${escapeHtml(entry.id)}')">
                  <span>⑂ 从这里分叉</span>
                </button>
                <div class="user-bubble ${!hasText && hasAttachments ? 'attachments-only' : ''}">
                  ${hasAttachments ? attachmentsHtml : ''}
                  ${hasText ? `<div class="user-text-body">${escapeHtml(rawText)}</div>` : ''}
                </div>
              `;
              container.appendChild(row);
            }
          } else if (entry.kind === 'assistant') {
            if (entry.error) {
              const errorMsg = entry.error;
              let count = 1;
              while (
                i + 1 < view.entries.length &&
                view.entries[i + 1].kind === 'assistant' &&
                view.entries[i + 1].error === errorMsg
              ) {
                count++;
                i++;
              }

              const row = document.createElement('div');
              row.className = 'message-row error-system-row';
              const countBadge = count > 1 ? ` <span class="error-count-badge">×${count}</span>` : '';
              row.innerHTML = `
                <div class="error-system-card">
                  <div class="error-system-main">
                    <span>模型调用失败：${escapeHtml(errorMsg)}</span>${countBadge}
                  </div>
                  <div class="error-system-sub">可以稍后重发，或检查模型服务</div>
                </div>
              `;
              container.appendChild(row);
            } else {
              const hasText = !!(entry.text && entry.text.trim());
              const hasToolCalls = Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0;

              // 没有 text、没有 toolCalls、也没有 error 的 assistant 条目不渲染空气泡
              if (!hasText && !hasToolCalls) {
                continue;
              }

              const row = document.createElement('div');
              row.className = 'message-row assistant-row';

              let assistantHtml = '<div class="assistant-wrapper">';
              if (hasText) {
                assistantHtml += `<div class="assistant-bubble md">${renderMarkdown(entry.text)}</div>`;
              }

              // 附带的工具调用卡片（含 delegate 子 Agent）
              if (hasToolCalls) {
                for (const call of entry.toolCalls) {
                  renderedToolCallIds.add(String(call.id));
                  const result = toolResultsMap.get(String(call.id));
                  const runningSlot = liveToolsMap.get(String(call.id));
                  assistantHtml += renderToolCardHtml(call.name, call.args, result, view.subagents, runningSlot);
                }
              }
              assistantHtml += '</div>';

              row.innerHTML = assistantHtml;
              container.appendChild(row);
            }
          } else if (entry.kind === 'tool') {
            if (!renderedToolCallIds.has(String(entry.toolCallId))) {
              const row = document.createElement('div');
              row.className = 'message-row assistant-row';
              row.innerHTML = `
                <div class="assistant-wrapper">
                  ${renderToolCardHtml(entry.name || '工具调用', null, entry, view.subagents)}
                </div>
              `;
              container.appendChild(row);
            }
          }
        }
      }

      // 4. 运行中状态（busy / live）
      updateBusyControls(isBusy, view.inbox || 0);

      if (isBusy) {
        const liveInfo = extractLiveInfo(view.live);
        const hasRunningTools = !!(liveInfo && Array.isArray(liveInfo.runningTools) && liveInfo.runningTools.length > 0);
        const hasLiveGeneration = !!(view.live && view.live.generation);

        // 3. 有工具在运行时，不要再显示“正在思考…”气泡；只有 live.generation 存在且没有工具在运行时才显示。
        const showThinkingBubble = hasLiveGeneration && !hasRunningTools;

        // 过滤掉已经在 assistant toolCall 中渲染过的运行中工具卡片
        const unrenderedRunningTools = hasRunningTools
          ? liveInfo.runningTools.filter(t => !t.callId || !renderedToolCallIds.has(String(t.callId)))
          : [];

        const hasLiveText = !!(liveInfo && liveInfo.text);
        const hasThinkingText = !!(showThinkingBubble && liveInfo && liveInfo.thinking);
        const shouldRenderLiveRow = hasLiveText || hasThinkingText || showThinkingBubble || unrenderedRunningTools.length > 0;

        if (shouldRenderLiveRow) {
          const liveRow = document.createElement('div');
          liveRow.className = 'message-row assistant-row';

          let liveInner = '<div class="assistant-wrapper">';

          if (hasLiveText) {
            liveInner += `
              <div class="assistant-bubble md">${renderMarkdown(liveInfo.text)}<span class="cursor-blink"></span></div>
            `;
          } else if (showThinkingBubble) {
            if (hasThinkingText) {
              liveInner += `
                <div class="live-bubble">
                  💭 正在思考：${escapeHtml(liveInfo.thinking)}<span class="cursor-blink"></span>
                </div>
              `;
            } else {
              liveInner += `
                <div class="live-bubble">
                  <span class="thinking-dots">正在思考<span>.</span><span>.</span><span>.</span></span>
                </div>
              `;
            }
          }

          if (unrenderedRunningTools.length > 0) {
            for (const t of unrenderedRunningTools) {
              liveInner += renderRunningToolCardHtml(t.name, t.args, t.output);
            }
          }

          liveInner += '</div>';
          liveRow.innerHTML = liveInner;
          container.appendChild(liveRow);
        }
      }

      // 5. 渲染侧边栏各面板
      renderNotes(view.notes);
      renderReminders(view.reminders);
      renderTasks(view.tasks);

      // 6. 渲染 Token 用量
      const tokenEl = document.getElementById('stat-tokens');
      if (tokenEl) {
        tokenEl.textContent = formatUsageTokens(view.usage);
      }

      // 7. 更新吉祥物小 D 状态
      updateMascotState();

      patchChildren(chatEl, container);

      // 自动滚到底部
      if (isNearBottom || autoScrollChat) {
        chatEl.scrollTop = chatEl.scrollHeight;
      }
    }

    // 渲染空会话示例按钮
    function renderEmptyConversation(container) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-chat-state';
      wrap.innerHTML = `
        <div class="empty-chat-badge">✨ Pi Durable Agent</div>
        <h2 class="empty-chat-title">开始与你的 Durable 助手对话</h2>
        <p class="empty-chat-desc">支持持久化存储、断点恢复、定时提醒与子 Agent 协同。点击下方预置任务立即体验：</p>
        <div class="example-prompts-grid">
          <div class="example-prompt-card" onclick="insertExamplePrompt('帮我看看 https://pi.dev 首页讲了什么，抓完等 20 秒再总结')">
            <div class="example-prompt-main">帮我看看 https://pi.dev 首页讲了什么，抓完等 20 秒再总结</div>
            <div class="example-prompt-sub">⚡ 演示断点恢复，等待时点模拟崩溃</div>
          </div>
          <div class="example-prompt-card" onclick="insertExamplePrompt('2 分钟后提醒我站起来活动一下')">
            <div class="example-prompt-main">2 分钟后提醒我站起来活动一下</div>
            <div class="example-prompt-sub">⏰ 演示后台提醒，关掉网页也会提醒</div>
          </div>
          <div class="example-prompt-card" onclick="insertExamplePrompt('派一个子 Agent 去看看 https://earendil.com 有什么新文章，再告诉我')">
            <div class="example-prompt-main">派一个子 Agent 去看看 https://earendil.com 有什么新文章，再告诉我</div>
            <div class="example-prompt-sub">🤖 演示子 Agent 独立协作</div>
          </div>
          <div class="example-prompt-card" onclick="insertExamplePrompt('记住：我喜欢简洁、带要点的回答')">
            <div class="example-prompt-main">记住：我喜欢简洁、带要点的回答</div>
            <div class="example-prompt-sub">📝 演示 Document 持久记忆</div>
          </div>
        </div>
      `;
      container.appendChild(wrap);
    }

    function insertExamplePrompt(text) {
      const textarea = document.getElementById('chat-textarea');
      if (textarea) {
        textarea.value = text;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
        textarea.focus();
      }
      updateSendButtonState();
    }

    function goBackToParentConversation(e) {
      e.preventDefault();
      const parentId = e.currentTarget.getAttribute('data-parent-id');
      if (parentId) {
        selectConversation(parentId);
      }
    }

    // 工具卡片构造（支持 delegate 子 Agent 样式与实时 runningSlot 输出）
    function renderToolCardHtml(name, args, result, subagents, runningSlot) {
      const isDone = !!result;
      const isError = result && !!result.isError;
      const resultText = result ? (result.text || '') : '';
      const isLong = resultText.length > 200;
      const previewText = isLong ? resultText.slice(0, 200) + '…' : resultText;

      const isSubagent = (name === 'delegate');
      const runningOutput = runningSlot ? getLastNonEmptyLine(runningSlot.output) : '';

      // 子 Agent 专用卡片样式
      if (isSubagent) {
        let taskDesc = args && args.task ? args.task : '';
        let targetConvId = null;

        // 从 subagents 列表或结果寻找对应的子会话 ID
        if (Array.isArray(subagents)) {
          const match = subagents.find(s => s.task === taskDesc || (s.task && taskDesc && s.task.includes(taskDesc)));
          if (match) targetConvId = match.conversationId;
          if (!targetConvId && subagents.length > 0) {
            targetConvId = subagents[subagents.length - 1].conversationId;
          }
        }
        if (!targetConvId && resultText) {
          const m = resultText.match(/会话\s*#?(\d+)/) || resultText.match(/conversationId["':\s]+(\d+)/);
          if (m) targetConvId = m[1];
        }

        const badgeClass = isError ? 'badge error' : (isDone ? 'badge done' : 'badge running');
        const badgeText = isError ? '执行失败' : (isDone ? '已完成' : '运行中');

        return `
          <div class="tool-card subagent-card ${isError ? 'error' : ''}">
            <div class="tool-card-header">
              <span class="tool-name-tag">🤖 子 Agent</span>
              <span class="tool-badge ${badgeClass}">${badgeText}</span>
            </div>
            ${taskDesc ? `<div style="font-size:13px; font-weight:500;">任务：${escapeHtml(taskDesc)}</div>` : ''}
            ${targetConvId ? `
              <div>
                <a class="subagent-jump-link" href="#${targetConvId}" onclick="selectConversation('${targetConvId}')">
                  查看子 Agent 对话 →
                </a>
              </div>
            ` : ''}
            ${isDone ? `
              <div class="tool-result-box">
                <div class="tool-result-content" id="tool-text-${escapeHtml(result.id || Math.random())}">${escapeHtml(previewText)}</div>
                ${isLong ? `
                  <button
                    class="tool-expand-btn"
                    data-full="${escapeHtml(resultText)}"
                    data-preview="${escapeHtml(previewText)}"
                    onclick="toggleToolResultExpand(this)"
                  >展开全文（共 ${resultText.length} 字）</button>
                ` : ''}
              </div>
            ` : `
              <div class="tool-result-box" style="color: ${runningOutput ? 'var(--primary)' : 'var(--text-muted)'}; font-size: 12.5px;">
                ${escapeHtml(runningOutput || '正在执行…')}
              </div>
            `}
          </div>
        `;
      }

      // 普通工具卡片
      const badgeClass = isError ? 'badge error' : (isDone ? 'badge done' : 'badge running');
      const badgeText = isError ? '执行失败' : (isDone ? '已完成' : '运行中');

      return `
        <div class="tool-card ${isError ? 'error' : ''}">
          <div class="tool-card-header">
            <span class="tool-name-tag">🛠️ ${escapeHtml(name)}</span>
            <span class="tool-badge ${badgeClass}">${badgeText}</span>
          </div>
          ${args ? `<div class="tool-args-box">${escapeHtml(formatToolArgs(args))}</div>` : ''}
          ${isDone ? `
            <div class="tool-result-box">
              <div class="tool-result-content" id="tool-text-${escapeHtml(result.id || Math.random())}">${escapeHtml(previewText)}</div>
              ${isLong ? `
                <button
                  class="tool-expand-btn"
                  data-full="${escapeHtml(resultText)}"
                  data-preview="${escapeHtml(previewText)}"
                  onclick="toggleToolResultExpand(this)"
                >展开全文（共 ${resultText.length} 字）</button>
              ` : ''}
            </div>
          ` : `
            <div class="tool-result-box" style="color: ${runningOutput ? 'var(--primary)' : 'var(--text-muted)'}; font-size: 12.5px;">
              ${escapeHtml(runningOutput || '正在执行…')}
            </div>
          `}
        </div>
      `;
    }

    function renderRunningToolCardHtml(name, args, output) {
      const lastLine = getLastNonEmptyLine(output);
      return `
        <div class="tool-card">
          <div class="tool-card-header">
            <span class="tool-name-tag">⚙️ ${escapeHtml(name)}</span>
            <span class="tool-badge running">运行中</span>
          </div>
          ${args ? `<div class="tool-args-box">${escapeHtml(formatToolArgs(args))}</div>` : ''}
          <div class="tool-result-box" style="color: var(--primary); font-size: 12.5px;">
            ${escapeHtml(lastLine || '执行中…')}
          </div>
        </div>
      `;
    }

    function toggleToolResultExpand(btn) {
      const contentEl = btn.previousElementSibling;
      const fullText = btn.getAttribute('data-full');
      const previewText = btn.getAttribute('data-preview');
      const isExpanded = btn.getAttribute('data-expanded') === 'true';

      if (isExpanded) {
        contentEl.textContent = previewText;
        btn.textContent = `展开全文（共 ${fullText.length} 字）`;
        btn.setAttribute('data-expanded', 'false');
      } else {
        contentEl.textContent = fullText;
        btn.textContent = '收起';
        btn.setAttribute('data-expanded', 'true');
      }
    }

    // 渲染记事本
    function renderNotes(notes) {
      const todoListEl = stagingFor('todo-list');
      const memoListEl = stagingFor('memo-list');

      if (todoListEl) {
        todoListEl.innerHTML = '';
        if (notes && Array.isArray(notes.todos) && notes.todos.length > 0) {
          notes.todos.forEach(t => {
            const item = document.createElement('div');
            item.className = 'todo-item' + (t.done ? ' done' : '');
            item.innerHTML = `
              <input type="checkbox" ${t.done ? 'checked' : ''} disabled>
              <span>${escapeHtml(t.text)}</span>
            `;
            todoListEl.appendChild(item);
          });
        } else {
          todoListEl.innerHTML = '<span class="empty-placeholder">暂无待办事项</span>';
        }
      }

      if (memoListEl) {
        memoListEl.innerHTML = '';
        if (notes && Array.isArray(notes.memos) && notes.memos.length > 0) {
          notes.memos.forEach(m => {
            const item = document.createElement('div');
            item.className = 'memo-item';
            item.innerHTML = `📌 <span>${escapeHtml(typeof m === 'string' ? m : m.text || JSON.stringify(m))}</span>`;
            memoListEl.appendChild(item);
          });
        } else {
          memoListEl.innerHTML = '<span class="empty-placeholder">暂无备忘录</span>';
        }
      }
    }

    // 渲染定时提醒面板
    function renderReminders(reminders) {
      const listEl = stagingFor('reminder-list');
      if (!listEl) return;
      listEl.innerHTML = '';

      if (!Array.isArray(reminders) || reminders.length === 0) {
        listEl.innerHTML = '<span class="empty-placeholder">暂无定时提醒</span>';
        return;
      }

      const now = Date.now();
      reminders.forEach(r => {
        const item = document.createElement('div');
        const isFired = (r.status === 'fired');
        item.className = 'reminder-item' + (isFired ? ' fired' : '');

        let badgeHtml = '';
        if (isFired) {
          badgeHtml = '<span class="reminder-badge fired">已提醒</span>';
        } else {
          const diff = r.at - now;
          const countdown = diff > 0 ? `倒计时 ${formatDuration(diff)}` : '即将触发';
          badgeHtml = `<span class="reminder-badge scheduled" data-at="${r.at}">${escapeHtml(countdown)}</span>`;
        }

        item.innerHTML = `
          <div class="reminder-info">
            <span class="reminder-text">⏰ ${escapeHtml(r.text)}</span>
            <span class="reminder-time">${escapeHtml(formatTime(r.at))}</span>
          </div>
          ${badgeHtml}
        `;
        listEl.appendChild(item);
      });
    }

    // 渲染持久任务面板（按 owner 缩进成树）
    const TASK_KIND_MAP = {
      'pi.generation': '调用模型',
      'pi.tool': '执行工具',
      'app.reminder': '定时提醒',
      'pi.compaction': '状态压缩'
    };

    const TASK_STATUS_MAP = {
      'pending': '排队',
      'running': '运行中',
      'waiting': '等待中',
      'completing': '收尾'
    };

    function renderTasks(tasks) {
      const treeEl = stagingFor('task-tree');
      if (!treeEl) return;
      treeEl.innerHTML = '';

      if (!Array.isArray(tasks) || tasks.length === 0) {
        treeEl.innerHTML = '<span class="empty-placeholder">空闲，没有正在运行的任务</span>';
        return;
      }

      // 构建 owner 父子树
      const taskMap = new Map();
      const childrenMap = new Map();
      const roots = [];

      tasks.forEach(t => {
        taskMap.set(t.id, t);
      });

      tasks.forEach(t => {
        if (t.owner && taskMap.has(t.owner)) {
          if (!childrenMap.has(t.owner)) {
            childrenMap.set(t.owner, []);
          }
          childrenMap.get(t.owner).push(t);
        } else {
          roots.push(t);
        }
      });

      // 递归渲染树节点
      function appendNode(task, depth = 0) {
        const node = document.createElement('div');
        node.className = 'task-node';
        node.style.paddingLeft = (depth * 16 + 6) + 'px';

        const kindName = TASK_KIND_MAP[task.kind] || task.kind;
        const statusClass = task.status || 'pending';
        const statusText = TASK_STATUS_MAP[task.status] || task.status;
        const branchPrefix = depth > 0 ? '<span class="task-branch-icon">└─ </span>' : '';

        node.innerHTML = `
          <div class="task-main">
            ${branchPrefix}
            <span class="task-name" title="${escapeHtml(task.id)}">${escapeHtml(kindName)}</span>
          </div>
          <span class="task-badge ${escapeHtml(statusClass)}">${escapeHtml(statusText)}</span>
        `;
        treeEl.appendChild(node);

        const children = childrenMap.get(task.id);
        if (children && children.length > 0) {
          children.forEach(child => appendNode(child, depth + 1));
        }
      }

      roots.forEach(root => appendNode(root, 0));
    }

    // 忙碌状态控制
    function updateBusyControls(isBusy, inboxCount) {
      const steerToggle = document.getElementById('steer-toggle');
      const btnAbort = document.getElementById('btn-abort');
      const inboxBadge = document.getElementById('inbox-badge');

      if (steerToggle) {
        steerToggle.style.display = isBusy ? 'inline-flex' : 'none';
      }
      if (btnAbort) {
        btnAbort.style.display = isBusy ? 'inline-flex' : 'none';
      }
      if (inboxBadge) {
        if (inboxCount > 0) {
          inboxBadge.textContent = `排队中：${inboxCount} 条`;
          inboxBadge.style.display = 'inline-block';
        } else {
          inboxBadge.style.display = 'none';
        }
      }
    }

    // --- 消息发送与交互 ---
    async function submitMessage() {
      if (isSending) return;
      const textarea = document.getElementById('chat-textarea');
      const text = (textarea ? textarea.value : '').trim();
      if (!text && pendingAttachments.length === 0) return;
      if (!currentConversationId) {
        await createNewConversation();
        if (!currentConversationId) return;
      }

      const steerCheckbox = document.getElementById('steer-checkbox');
      const mode = steerCheckbox && steerCheckbox.checked ? 'steer' : 'followUp';
      const requestId = generateUuid();
      const btnSend = document.getElementById('btn-send');

      isSending = true;
      if (btnSend) {
        btnSend.disabled = true;
        btnSend.textContent = '发送中…';
      }

      const attachmentsPayload = pendingAttachments.map(att => ({
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
      }));

      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(currentConversationId)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            requestId,
            mode,
            attachments: attachmentsPayload,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'HTTP ' + res.status);
        }
        // 成功后清空输入框与待发送附件
        if (textarea) {
          textarea.value = '';
          textarea.style.height = 'auto';
        }
        clearPendingAttachments();
        fetchConversations();
      } catch (err) {
        showToast('发送失败：' + err.message, 'error');
        // 出错时保留输入框内容和待发送附件，方便重试
      } finally {
        isSending = false;
        if (btnSend) {
          btnSend.textContent = '发送';
          updateSendButtonState();
        }
      }
    }

    async function abortCurrentTask() {
      if (!currentConversationId) return;
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(currentConversationId)}/abort`, {
          method: 'POST',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || '停止失败');
        }
      } catch (err) {
        alert('停止失败：' + err.message);
      }
    }

    // 从某条消息分叉
    async function forkConversation(entryId) {
      if (!currentConversationId || !entryId) return;
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(currentConversationId)}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || '分叉会话失败');
        }
        const data = await res.json();
        selectConversation(data.id);
        await fetchConversations();
      } catch (err) {
        alert('分叉失败：' + err.message);
      }
    }

    // --- 模拟崩溃二次确认 ---
    const crashModal = document.getElementById('crash-modal');

    function openCrashModal() {
      crashModal.style.display = 'flex';
    }

    function closeCrashModal() {
      crashModal.style.display = 'none';
    }

    function onModalBackdropClick(e) {
      if (e.target === crashModal) {
        closeCrashModal();
      }
    }

    async function confirmCrash() {
      closeCrashModal();
      showReconnectBanner();
      try {
        const res = await fetch('/api/crash', { method: 'POST' });
        if (!res.ok) {
          console.warn('POST /api/crash 返回非 200');
        }
      } catch (err) {
        console.log('模拟崩溃已触发，服务断开连接');
      }
    }

    // --- 移动端抽屉控制 ---
    function openSidebarDrawer() {
      document.getElementById('sidebar-left').classList.add('open');
      document.getElementById('drawer-backdrop').classList.add('open');
    }

    function closeSidebarDrawer() {
      document.getElementById('sidebar-left').classList.remove('open');
      document.getElementById('drawer-backdrop').classList.remove('open');
    }

    // --- 倒计时时钟（每秒更新一次定时提醒面板和小 D 倒计时文案） ---
    function startTimerTick() {
      if (timerTickInterval) clearInterval(timerTickInterval);
      timerTickInterval = setInterval(() => {
        const now = Date.now();
        // 1. 更新定时提醒面板内的倒计时徽章
        const badges = document.querySelectorAll('.reminder-badge.scheduled');
        badges.forEach(badge => {
          const at = Number(badge.getAttribute('data-at'));
          if (at) {
            const diff = at - now;
            badge.textContent = diff > 0 ? `倒计时 ${formatDuration(diff)}` : '即将触发';
          }
        });

        // 2. 如果吉祥物处于提醒状态，刷新气泡中的倒计时
        const mascotCard = document.getElementById('mascot-card');
        if (mascotCard && mascotCard.getAttribute('data-state') === 'reminder') {
          updateMascotState();
        }
      }, 1000);
    }

    // --- 定时拉取会话列表（每 10 秒刷新一次会话列表标题） ---
    function startConversationsInterval() {
      if (conversationsInterval) clearInterval(conversationsInterval);
      conversationsInterval = setInterval(() => {
        fetchConversations();
      }, 10000);
    }

    // --- 事件监听与初始化 ---
    window.addEventListener('DOMContentLoaded', () => {
      setupMascotSvgs();
      fetchServerInfo();
      fetchConversations(true);
      startTimerTick();
      startConversationsInterval();
      setupDragAndDrop();

      const chatContainer = document.getElementById('messages-container');
      if (chatContainer) {
        chatContainer.addEventListener('scroll', () => {
          autoScrollChat = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 80;
        });
      }

      const fileInput = document.getElementById('file-input');
      if (fileInput) {
        fileInput.addEventListener('change', async () => {
          if (fileInput.files && fileInput.files.length > 0) {
            await handleFilesSelected(fileInput.files);
          }
        });
      }

      const textarea = document.getElementById('chat-textarea');
      if (textarea) {
        textarea.addEventListener('input', () => {
          textarea.style.height = 'auto';
          textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
          updateSendButtonState();
        });

        textarea.addEventListener('paste', async (e) => {
          const clipboardData = e.clipboardData;
          if (!clipboardData || !clipboardData.files || clipboardData.files.length === 0) return;
          const files = Array.from(clipboardData.files);
          if (files.length > 0) {
            e.preventDefault();
            await handleFilesSelected(files);
          }
        });

        textarea.addEventListener('compositionstart', () => { isComposing = true; });
        textarea.addEventListener('compositionend', () => {
          isComposing = false;
          updateSendButtonState();
        });

        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
            e.preventDefault();
            submitMessage();
          }
        });
      }

      // 手机上输入框较窄，长提示会折成两行被截断
      if (textarea && window.matchMedia('(max-width: 860px)').matches) {
        textarea.placeholder = '输入消息…';
      }

      updateSendButtonState();

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && crashModal.style.display === 'flex') {
          closeCrashModal();
        }
      });

      window.addEventListener('hashchange', () => {
        const hashId = parseHashConversationId();
        if (hashId !== null && String(hashId) !== String(currentConversationId)) {
          const hashed = conversations.find((c) => String(c.id) === String(hashId));
          if (hashed?.archivedAt) conversationView = 'archived';
          selectConversation(hashId);
        }
      });

      const conversationList = document.getElementById('conversation-list');
      if (conversationList) conversationList.addEventListener('click', onConversationListClick);
    });

    // 显式挂载到 window，确保 inline onclick 与外部完全兼容
    window.submitMessage = submitMessage;
    window.abortCurrentTask = abortCurrentTask;
    window.forkConversation = forkConversation;
    window.openCrashModal = openCrashModal;
    window.closeCrashModal = closeCrashModal;
    window.confirmCrash = confirmCrash;
    window.onModalBackdropClick = onModalBackdropClick;
    window.openSidebarDrawer = openSidebarDrawer;
    window.closeSidebarDrawer = closeSidebarDrawer;
    window.createNewConversation = createNewConversation;
    window.setConversationView = setConversationView;
    window.goBackToParentConversation = goBackToParentConversation;
    window.toggleMobileMascotBubble = toggleMobileMascotBubble;
    window.toggleToolResultExpand = toggleToolResultExpand;
    window.insertExamplePrompt = insertExamplePrompt;
    window.triggerFileInput = triggerFileInput;
    window.removePendingAttachment = removePendingAttachment;
    window.showToast = showToast;
