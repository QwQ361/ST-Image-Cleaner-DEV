// Image Cleaner - 聊天图片净化插件
// 功能：为聊天图片提供「下载净化图 / 复制净化图」按钮，
//       通过 Canvas 重绘彻底剥离 EXIF / PNG tEXt / XMP / 画师串等全部元数据，输出 WebP。
// 入口：ES Module，由酒馆 extensions.js 注入页面。

import { MEDIA_TYPE } from "../../../constants.js";
import { getContext } from "../../../extensions.js";
import { download } from "../../../utils.js";

// 全局上下文（兜底 null，避免酒馆初始化异常时整个插件崩掉）
const ctx = getContext();

// 扩展名常量：用于 settings 命名空间与 DOM 前缀
const EXTENSION_NAME = "Image-Cleaner";
const EXTENSION_PREFIX = "image-cleaner";

// 安全检测 Canvas 能力（剪贴板写入在 handleCopy 内做运行时检测与回退）
const CANVAS_OK =
  typeof document !== "undefined" &&
  !!document.createElement("canvas").getContext;

/**
 * 读取并初始化插件设置（惰性初始化 + 旧值迁移）
 * 配置挂在 extension_settings[EXTENSION_NAME] 下
 */
function getSettings() {
  const s = ctx?.extensionSettings || {};
  if (!s[EXTENSION_NAME]) s[EXTENSION_NAME] = {};

  const g = s[EXTENSION_NAME];
  // 输出格式：webp（默认）| png（保留透明，但画师串仍被剥离）
  if (g.outputFormat === undefined) g.outputFormat = "webp";
  // 输出质量（0~1，webp 有效；png 忽略）
  if (g.quality === undefined) g.quality = 0.9;
  // 保留 copyWebp 兼容旧配置（Chromium 剪贴板仅支持 PNG，复制固定输出 PNG）
  if (g.copyWebp === undefined) g.copyWebp = true;
  // 跨域/CORS 失败时是否回退下载原图
  if (g.fallbackOriginal === undefined) g.fallbackOriginal = true;

  return g;
}

/**
 * 保存设置（防抖）
 */
function saveSettings() {
  ctx?.saveSettingsDebounced?.();
}

/**
 * 从当前消息容器解析图片媒体信息
 * @param {JQuery} imgEl 图片的 jQuery 元素（.mes_img）
 * @returns {{mesid:number, mediaIndex:number, media:Object|null}}
 */
function getMediaInfo(imgEl) {
  const mes = $(imgEl).closest(".mes");
  const mesid = Number(mes.attr("mesid"));
  const container = $(imgEl).closest(".mes_media_container");
  const index = Number(container.attr("data-index"));

  if (Number.isNaN(mesid) || Number.isNaN(index) || !ctx?.chat?.[mesid]) {
    return { mesid, mediaIndex: index, media: null };
  }

  const media = ctx.chat[mesid].extra?.media?.[index];
  if (!media || media.type !== MEDIA_TYPE.IMAGE) {
    return { mesid, mediaIndex: index, media: null };
  }

  return { mesid, mediaIndex: index, media };
}

/**
 * 加载图片到 HTMLImageElement（处理 data URL 与同源/跨域 URL）
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`无法加载图片：${src?.slice?.(0, 80) || "(未知来源)"}`));
    // 跨域图片绘制到 canvas 需要 CORS 模式，否则 canvas 会被污染
    img.crossOrigin = "anonymous";
    img.src = src;
  });
}

/**
 * 检测图片是否含透明像素（采样检查）
 * @param {HTMLImageElement} img
 * @returns {boolean}
 */
function hasTransparency(img) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return false;
    g.drawImage(img, 0, 0);
    // 采样像素：先检查角落，全图扫描开销大时用步进采样
    const w = canvas.width;
    const h = canvas.height;
    // ⚠️ 阈值用 250 而非 255：PNG 抗锯齿边缘的 alpha 常为 250~254，
    // 误判透明会把本可输出 WebP 的图强制转成 PNG（已在 Chromium 实测确认根因）。
    // 真透明像素 alpha 会显著低于 250；alpha∈[250,255) 肉眼不可辨。
    const ALPHA_THRESHOLD = 250;
    const sample = (x, y) => g.getImageData(x, y, 1, 1).data[3];
    if (
      sample(0, 0) < ALPHA_THRESHOLD ||
      sample(w - 1, 0) < ALPHA_THRESHOLD ||
      sample(0, h - 1) < ALPHA_THRESHOLD ||
      sample(w - 1, h - 1) < ALPHA_THRESHOLD
    ) {
      return true;
    }
    // 步进采样中线（性能优先，足够用于判断是否有透明区域）
    const step = Math.max(1, Math.floor(Math.min(w, h) / 16));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (g.getImageData(x, y, 1, 1).data[3] < ALPHA_THRESHOLD) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 通过 Canvas 重绘生成净化后的 Blob（剥离全部元数据）
 * @param {Blob} blob 原始图片
 * @param {string} outputFormat 输出格式 'webp' | 'png'
 * @param {number} quality 质量 0~1（webp 有效）
 * @returns {Promise<{blob:Blob, transparent:boolean, animated:boolean}>}
 */
async function purifyImage(blob, outputFormat, quality) {
  const src = URL.createObjectURL(blob);
  try {
    const img = await loadImage(src);

    // 动图检测：GIF 或 APNG（canvas 重绘只会取首帧）
    const animated = blob.type === "image/gif" || blob.type === "image/apng";

    // 透明通道检测（webp 不支持透明，png 支持）
    const transparent = hasTransparency(img);

    // 实际输出格式：webp + 透明图 → 强制 png，避免黑底
    let type = outputFormat;
    if (type === "webp" && transparent) {
      type = "png";
    }

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext("2d");
    // 非透明图先铺白底（避免透明区域在 jpeg 变黑，webp 无损则不影响）
    if (!transparent) {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(img, 0, 0);

    const mime = type === "png" ? "image/png" : "image/webp";
    const outBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Canvas 导出失败"))),
        mime,
        quality,
      );
    });

    return { blob: outBlob, transparent, animated };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/**
 * 生成净化图文件名（保留原始前缀 + 格式后缀）
 */
function makeCleanFileName(originalName, ext) {
  const base = originalName
    ? originalName.replace(/\.[^.]+$/, "")
    : `image_clean_${Date.now()}`;
  return `${base}_clean.${ext}`;
}

/**
 * 下载净化图
 */
async function handleDownload(media, imgEl) {
  const settings = getSettings();
  const fileName = media.title || media.name || "";
  try {
    const res = await fetch(media.url);
    if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`);
    const blob = await res.blob();

    const {
      blob: outBlob,
      transparent,
      animated,
    } = await purifyImage(blob, settings.outputFormat, settings.quality);

    const ext = outBlob.type === "image/png" ? "png" : "webp";
    download(outBlob, makeCleanFileName(fileName, ext), outBlob.type);

    const notes = [];
    if (animated) notes.push("动图已取首帧");
    if (transparent) notes.push("透明通道已保留(PNG)");
    toastr.success(
      `已下载净化图 (${outBlob.type})${notes.length ? "：" + notes.join("，") : ""}`,
    );
  } catch (err) {
    console.error("[Image-Cleaner] 下载失败", err);
    if (settings.fallbackOriginal) {
      // 用原生 <a> 标签下载原图（不能用 utils.download，它会将 URL 字符串当文本写入 Blob）
      const a = document.createElement("a");
      a.href = media.url;
      a.download = fileName || "image";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toastr.warning(`净化失败，已回退下载原图：${err.message}`);
    } else {
      toastr.error(`净化失败：${err.message}`);
    }
  }
}

/**
 * 复制净化图到剪贴板
 *
 * ⚠️ 硬限制（已在 Chromium 153 实测验证）：Chromium 系浏览器（Chrome/Edge 全版本）
 * 的 navigator.clipboard.write() 只接受 image/png 一种图片 MIME，
 * image/webp / image/jpeg / image/gif / image/bmp / image/avif 及自定义类型
 * 一律抛 NotAllowedError "Type ... not supported on write"；
 * ClipboardItem.supports("image/webp") 也恒返回 false。
 * 这是浏览器安全模型限制，前端 JS 无法绕过（网上「Chrome 128+ 支持写 WebP」为误传）。
 * 因此复制固定输出 PNG（同样经 canvas 重绘，画师串/EXIF 等元数据已剥离）；
 * 需要 WebP 请使用「下载净化图」按钮。
 */
async function handleCopy(media) {
  const settings = getSettings();
  try {
    const res = await fetch(media.url);
    if (!res.ok) throw new Error(`获取图片失败 (HTTP ${res.status})`);
    const blob = await res.blob();

    const { blob: outBlob, transparent } = await purifyImage(
      blob,
      settings.outputFormat,
      settings.quality,
    );

    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error("当前浏览器不支持剪贴板图片写入");
    }

    // Chromium 剪贴板仅接受 image/png：产物是 webp 则转 png（透明图在 purifyImage 中已是 png）
    const targetBlob =
      outBlob.type === "image/png" ? outBlob : await convertBlobToPng(outBlob);
    const itemType = "image/png";

    await writeToClipboard(targetBlob, itemType);

    const notes = [];
    if (transparent) {
      notes.push("透明通道已保留(PNG)");
    }
    toastr.success(
      `已复制净化图 (PNG)${notes.length ? "：" + notes.join("，") : ""}｜Chromium 剪贴板仅支持 PNG，WebP 请用下载按钮`,
    );
  } catch (err) {
    console.error("[Image-Cleaner] 复制失败", err);
    toastr.error(`复制失败：${err.message}`);
  }
}

/**
 * 写入图片到剪贴板
 */
async function writeToClipboard(blob, type) {
  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
}

/**
 * 将任意图片 Blob 转成 PNG Blob（作为复制回退）
 */
async function convertBlobToPng(blob) {
  const src = URL.createObjectURL(blob);
  try {
    const img = await loadImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext("2d");
    g.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG 转换失败"))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(src);
  }
}

/**
 * 事件委托：点击「下载净化图」
 */
$(document).on("click", `.${EXTENSION_PREFIX}-download`, function () {
  const info = getMediaInfo(this);
  if (!info.media) {
    toastr.warning("未找到图片信息");
    return;
  }
  handleDownload(info.media, this);
});

/**
 * 事件委托：点击「复制净化图」
 */
$(document).on("click", `.${EXTENSION_PREFIX}-copy`, function () {
  const info = getMediaInfo(this);
  if (!info.media) {
    toastr.warning("未找到图片信息");
    return;
  }
  handleCopy(info.media);
});

// ========== 自定义右键菜单 ==========
// 背景：浏览器原生右键「将图片另存为」保存的是原始文件（如 PNG 含画师串/EXIF），
// 且该动作由浏览器接管、JS 无法拦截或改格式。这里拦截 contextmenu 事件，
// 弹出插件自己的菜单，提供「下载净化图(WebP)/复制净化图(PNG)」。
// 事件委托到 document：无论图片由哪个插件（酒馆核心/文生图/第三方）渲染，
// 只要 DOM 里是 .mes_img 就能命中。
const MENU_CLASS = `${EXTENSION_PREFIX}-context-menu`;
const MENU_ITEM_DOWNLOAD = `${EXTENSION_PREFIX}-ctx-download`;
const MENU_ITEM_COPY = `${EXTENSION_PREFIX}-ctx-copy`;

/** 当前右键菜单对应的图片元素（供菜单项点击时取用） */
let contextMenuImg = null;

/**
 * 关闭自定义右键菜单
 */
function closeContextMenu() {
  $(`.${MENU_CLASS}`).remove();
  contextMenuImg = null;
}

/**
 * 弹出自定义右键菜单的挂载容器：
 * 图片在 <dialog>（showModal 打开的 top layer 弹窗，如大图预览）内时，
 * 必须挂进 dialog 内部才能盖过弹窗；否则挂 body。
 * @param {HTMLElement} imgEl
 * @returns {HTMLElement}
 */
function getContextMenuHost(imgEl) {
  const dialog = imgEl && imgEl.closest ? imgEl.closest("dialog") : null;
  if (dialog && dialog.open) return dialog;
  return document.body;
}

/**
 * 在鼠标位置弹出自定义右键菜单
 * @param {MouseEvent} e
 * @param {HTMLElement} imgEl 被右键的图片元素
 */
function showContextMenu(e, imgEl) {
  closeContextMenu();

  const menu = $(`
    <div class="${MENU_CLASS}">
      <div class="${MENU_ITEM_DOWNLOAD}">
        <i class="fa-solid fa-download"></i>
        <span>下载净化图 (WebP)</span>
      </div>
      <div class="${MENU_ITEM_COPY}">
        <i class="fa-solid fa-copy"></i>
        <span>复制净化图 (PNG)</span>
      </div>
    </div>
  `);

  // 先挂到容器计算尺寸，再定位（避免超出视口被裁）
  $(getContextMenuHost(imgEl)).append(menu);
  const menuWidth = menu.outerWidth();
  const menuHeight = menu.outerHeight();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = e.clientX;
  let top = e.clientY;
  if (left + menuWidth > vw) left = Math.max(0, vw - menuWidth - 8);
  if (top + menuHeight > vh) top = Math.max(0, vh - menuHeight - 8);
  menu.css({ left: `${left}px`, top: `${top}px` });

  contextMenuImg = imgEl;

  // 点击菜单项：下载 / 复制
  menu.find(`.${MENU_ITEM_DOWNLOAD}`).on("click", () => {
    const mediaInfo = resolveMediaFromImg(contextMenuImg);
    if (mediaInfo) {
      handleDownload(mediaInfo, contextMenuImg);
    } else {
      downloadRawImageFromSrc(contextMenuImg);
    }
    closeContextMenu();
  });
  menu.find(`.${MENU_ITEM_COPY}`).on("click", () => {
    const mediaInfo = resolveMediaFromImg(contextMenuImg);
    if (mediaInfo) {
      handleCopy(mediaInfo);
    } else {
      copyRawImageFromSrc(contextMenuImg);
    }
    closeContextMenu();
  });
}

/**
 * 从 .mes_img 解析 media 信息；失败返回 null
 */
function resolveMediaFromImg(imgEl) {
  try {
    const info = getMediaInfo(imgEl);
    if (info.media) return info.media;
  } catch {
    // fallthrough
  }
  return null;
}

/**
 * 兜底：直接从 <img> 的 src 下载净化图（拿不到 chat.extra.media 时）
 */
async function downloadRawImageFromSrc(imgEl) {
  const src = $(imgEl).attr("src");
  if (!src) {
    toastr.warning("无法获取图片地址");
    return;
  }
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`获取图片失败 (HTTP ${res.status})`);
    const blob = await res.blob();
    const settings = getSettings();
    const {
      blob: outBlob,
      transparent,
      animated,
    } = await purifyImage(blob, settings.outputFormat, settings.quality);
    const ext = outBlob.type === "image/png" ? "png" : "webp";
    download(outBlob, makeCleanFileName("", ext), outBlob.type);
    const notes = [];
    if (animated) notes.push("动图已取首帧");
    if (transparent) notes.push("透明通道已保留(PNG)");
    toastr.success(
      `已下载净化图 (${outBlob.type})${notes.length ? "：" + notes.join("，") : ""}`,
    );
  } catch (err) {
    console.error("[Image-Cleaner] 右键下载失败", err);
    toastr.error(`下载失败：${err.message}`);
  }
}

/**
 * 兜底：直接从 <img> 的 src 复制净化图（拿不到 chat.extra.media 时）
 */
async function copyRawImageFromSrc(imgEl) {
  const src = $(imgEl).attr("src");
  if (!src) {
    toastr.warning("无法获取图片地址");
    return;
  }
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`获取图片失败 (HTTP ${res.status})`);
    const blob = await res.blob();
    const settings = getSettings();
    const { blob: outBlob, transparent } = await purifyImage(
      blob,
      settings.outputFormat,
      settings.quality,
    );
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error("当前浏览器不支持剪贴板图片写入");
    }
    const targetBlob =
      outBlob.type === "image/png" ? outBlob : await convertBlobToPng(outBlob);
    await writeToClipboard(targetBlob, "image/png");
    const notes = [];
    if (transparent) notes.push("透明通道已保留(PNG)");
    toastr.success(
      `已复制净化图 (PNG)${notes.length ? "：" + notes.join("，") : ""}｜Chromium 剪贴板仅支持 PNG，WebP 请用下载`,
    );
  } catch (err) {
    console.error("[Image-Cleaner] 右键复制失败", err);
    toastr.error(`复制失败：${err.message}`);
  }
}

// 拦截图片右键 → 弹自定义菜单（覆盖酒馆内所有实义 <img>：聊天区 .mes_img 消息图、
// 文生图插件渲染的图、头像、大图预览弹窗 .img_enlarged、表情图等；
// 非 .mes_img 自动走 src 兜底净化）
// 过滤无实义的占位图/装饰图，避免误伤：
//   空 src / data:, / 1px 透明 gif（懒加载占位）、No-Image 占位符、头像裁剪框底图
$(document).on("contextmenu", "img", function (e) {
  const src = $(this).attr("src") || "";
  if (!src || src === "data:,") return;
  if (/^data:image\/gif;base64,R0lGODlhAQAB/.test(src)) return; // 1px 透明 gif（懒加载占位）
  if (/No-Image-Placeholder\.svg/.test(src)) return; // 无图占位符
  if ($(this).hasClass("popup-crop-image")) return; // 头像裁剪框底图（src 无实义）
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e, this);
});

// 点击空白处关闭菜单
$(document).on("click", function (e) {
  if (!$(e.target).closest(`.${MENU_CLASS}`).length) {
    closeContextMenu();
  }
});

// 滚动/窗口尺寸变化时关闭（菜单是固定定位，滚动后会错位）
$(document).on("scroll", closeContextMenu);
$(window).on("resize", closeContextMenu);
// Escape 关闭
$(document).on("keydown", function (e) {
  if (e.key === "Escape") closeContextMenu();
});

/**
 * 向图片悬浮控制栏注入「下载」「复制」按钮（幂等）
 */
function injectButtons() {
  const template = $("#message_image_template");
  if (template.length === 0) return;
  const controls = template.find(".mes_img_controls");
  if (controls.length === 0) return;

  // 幂等检查
  if (template.find(`.${EXTENSION_PREFIX}-download`).length > 0) return;

  // 下载按钮
  $("<div>")
    .addClass("right_menu_button fa-lg fa-solid fa-download")
    .addClass(`${EXTENSION_PREFIX}-download`)
    .attr("title", "下载净化图（剥离画师串/EXIF 等元数据）")
    .appendTo(controls);

  // 复制按钮
  $("<div>")
    .addClass("right_menu_button fa-lg fa-solid fa-copy")
    .addClass(`${EXTENSION_PREFIX}-copy`)
    .attr("title", "复制净化图（剥离画师串/EXIF 等元数据）")
    .appendTo(controls);
}

/**
 * 注入扩展设置 UI 到扩展管理面板
 */
function injectSettingsUI() {
  // 注入到扩展管理面板的设置容器（与 st-kimi-reasoning-injector 等先例一致）
  const settingsContainer = $("#extensions_settings");
  if (settingsContainer.length === 0) return;

  const settings = getSettings();

  const block = $(`
        <div class="inline-drawer ${EXTENSION_PREFIX}-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Image Cleaner 净化设置</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="flex-container flexGap5">
                    <label class="checkbox_label">
                        <input type="checkbox" class="${EXTENSION_PREFIX}-setting-fallback" ${settings.fallbackOriginal ? "checked" : ""} />
                        <span>跨域/失败时回退下载原图</span>
                    </label>
                    <small>复制：Chromium 剪贴板仅支持 PNG（WebP 请用「下载净化图」按钮）</small>
                    <small>输出格式与质量（webp/png、质量 0~1）</small>
                    <select class="${EXTENSION_PREFIX}-setting-format">
                        <option value="webp" ${settings.outputFormat === "webp" ? "selected" : ""}>WebP（默认，文件小，画师串必去）</option>
                        <option value="png" ${settings.outputFormat === "png" ? "selected" : ""}>PNG（保留透明通道）</option>
                    </select>
                    <input type="number" class="${EXTENSION_PREFIX}-setting-quality" min="0.1" max="1" step="0.05" value="${settings.quality}" />
                </div>
            </div>
        </div>
    `);

  settingsContainer.append(block);

  // 事件绑定
  block.find(`.${EXTENSION_PREFIX}-setting-fallback`).on("change", function () {
    getSettings().fallbackOriginal = $(this).prop("checked");
    saveSettings();
  });
  block.find(`.${EXTENSION_PREFIX}-setting-format`).on("change", function () {
    getSettings().outputFormat = $(this).val();
    saveSettings();
  });
  block.find(`.${EXTENSION_PREFIX}-setting-quality`).on("change", function () {
    const q = Number($(this).val());
    getSettings().quality = Math.min(1, Math.max(0.1, q || 0.9));
    $(this).val(getSettings().quality);
    saveSettings();
  });
}

/**
 * 插件启动
 */
jQuery(async () => {
  try {
    // 注入按钮到图片控制栏（模板会在每次消息渲染时克隆，克隆含按钮）
    injectButtons();

    // 注入设置 UI
    injectSettingsUI();
  } catch (err) {
    console.error("[Image-Cleaner] 启动失败", err);
  }
});
