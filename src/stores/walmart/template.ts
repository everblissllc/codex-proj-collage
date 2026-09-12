import type { GeneratedContent, ProductData } from "../../types";
import { walmartTheme as t } from "./theme";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function walmartCardHtml(product: ProductData, content: GeneratedContent, imageDataUrl: string): string {
  const title = escapeHtml(content.shortTitle);
  const current = escapeHtml(product.currentPrice.formatted);
  const old = product.oldPrice ? `<span class="old-price">${escapeHtml(product.oldPrice.formatted)}</span>` : "";
  const titleSize = content.shortTitle.length > 75 ? 49 : content.shortTitle.length > 58 ? 56 : 66;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><meta name="viewport" content="width=${t.width}, initial-scale=1"><style>
    *{box-sizing:border-box}html,body{margin:0;width:${t.width}px;height:${t.height}px;overflow:hidden;background:${t.background}}
    .card{width:${t.width}px;height:${t.height}px;background:${t.background};display:flex;flex-direction:column;padding:58px 74px 66px;font-family:${t.bodyFont}}
    .image-area{height:735px;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .image-area img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
    .title-area{height:225px;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:4px 22px}
    .title{color:${t.titleBlue};font-family:${t.titleFont};font-size:${titleSize}px;font-weight:700;line-height:1.12;text-align:center;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;max-height:100%}
    .price-row{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;gap:30px;white-space:nowrap}
    .current-price{color:${t.saleGreen};font-size:99px;font-weight:800;letter-spacing:-3px}
    .now{font-size:64px;letter-spacing:0;margin-right:17px}
    .old-price{color:${t.oldPriceGray};font-size:51px;font-weight:600;text-decoration:line-through;text-decoration-thickness:4px}
  </style></head><body><main class="card"><div class="image-area"><img src="${imageDataUrl}" alt="" loading="eager" decoding="sync"></div><div class="title-area"><div class="title">${title}</div></div><div class="price-row"><span class="current-price"><span class="now">Now</span>${current}</span>${old}</div></main><script>
    const card = document.querySelector(".card");
    const image = document.querySelector(".image-area img");
    if (card && image) {
      const markReady = () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) card.setAttribute("data-card-ready", "true");
      };
      if (image.decode) image.decode().then(markReady).catch(() => {});
      else if (image.complete) markReady();
      else image.addEventListener("load", markReady, { once: true });
    }
  </script></body></html>`;
}
