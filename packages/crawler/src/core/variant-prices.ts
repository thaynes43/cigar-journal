import { decodeEntities } from "./normalize.js";
import type { VariantPriceSource } from "../adapters/types.js";

// THE PRICES A GROUPED PRODUCT KEEPS IN ITS HTML (ADR-015, issue #270).
//
// Every other price in this crawler comes out of structured markup, and that is
// the rule this module is the single, declared exception to. A nopCommerce
// GROUPED product has no single price — it is a parent over N pack sizes — so
// the schema.org Product node publishes `offers.price: "0.00"` and the real
// figures exist only in the page's `product-variant-list`. Small Batch Cigar
// does this on every cigar it sells: 20 of 20 sampled pages on the 2026-09-02
// probe, and the reason its offers carried no price at all until now.
//
// It is REACHED ONLY THROUGH `adapter.variantPrices`. Nothing sniffs a page for
// this shape, for the same reason nothing sniffs `productMarkup`: a shop's page
// shape is a declaration about that shop, and a silent template change should
// fail loudly at the probe rather than quietly start parsing someone's CSS.
//
// LIVE SHAPE, read in-cluster 2026-09-03 (fixtures `small-batch/live-product-*`):
//
//   <div class="product-variant-list">
//     <div class="product-variant-line" data-productid="23479">
//       <div class="variant-overview">
//         <div class="variant-name">Sobremesa Solita Short Churchill - Pack of 5</div>
//         <div class="availability"><div class="stock">
//           <span class="label">FREE SHIPPING</span>
//           <span class="value" id="stock-availability-value-23479">Low stock</span>
//         </div></div>
//         <style>… .variant-overview {…} …</style>
//         <div class="prices"><div class="product-price">
//           <span id="price-value-23479" class="price-value-23479"> $71.00 </span>
//         </div></div>
//         …add-to-cart, wishlist modals…
//
// Two properties of that markup decide how this is parsed. The class
// `variant-overview` ALSO appears inside the inline `<style>` blocks each line
// carries — fourteen occurrences on a two-variant page — so the class name is
// not an anchor. `data-productid` is: the line, its stock span and its price
// span all carry the same id, so name, availability and price are paired BY ID
// rather than by proximity, and a template that reorders them cannot silently
// pair one variant's label with another's price.

export interface VariantPrice {
  // The label the shop wrote, entity-decoded. Carried through to the offer's raw
  // payload so a curator can see what the number was a price FOR.
  label: string;
  // The packaging phrase alone: the label's tail after its last " - ", which is
  // where this platform puts the unit (`Pack of 5`, `Box of 14`, `Bundle of 25`)
  // and never puts anything else. Null when the label has no such tail.
  //
  // It exists so the packaging parse does not read the PRODUCT NAME: the shop
  // prefixes every label with the product's own name, and a cigar called
  // `… Tubos` or `… Cabinet` would otherwise hand the shared packaging
  // vocabulary a container word off its identity rather than off its unit.
  unit: string | null;
  priceCents: number | null;
  currency: string | null;
  inStock: boolean | null;
}

// Each variant line, from its opening tag to the next line's (or the end of the
// list). The tag itself is the split point; `data-productid` comes off the chunk.
const VARIANT_LINE = /<div class="product-variant-line"[^>]*data-productid="(\d+)"[^>]*>/gi;

// The label. `variant-name` is a div on this platform and its content is plain
// text, so a non-greedy read to the first `</div>` is the whole label.
const VARIANT_NAME = /<div class="variant-name"[^>]*>([\s\S]*?)<\/div>/i;

// The currency symbols this platform serves. A price whose symbol is not one of
// these keeps its amount and records NO currency — ADR-009's rule that an
// unstated fact is never invented, applied one field down.
const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/\$/, "USD"],
  [/€/, "EUR"],
  [/£/, "GBP"],
];

// The SAME decoder the product name goes through (`normalize.ts`), plus a
// whitespace collapse — the price span is served as ` $71.00 ` and the labels
// carry `&#x27;` for an apostrophe. One decoder, because a variant label that
// decoded differently from the name it is a variant OF would be a second
// vocabulary to keep in step. Type-only in the other direction, so the pair
// never forms a runtime import cycle.
function decode(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

// ` $1,234.00 ` → 123400. Thousands separators are dropped; a string with no
// digits at all yields null rather than 0, because "no price shown" and "free"
// are different claims and only one of them is ever true here.
export function priceTextToCents(text: string): number | null {
  // `\s` plus the non-breaking space, spelled as an ESCAPE: an `&nbsp;` decodes
  // to U+00A0, which `\s` does not cover and which a literal would hide.
  const cleaned = text.replace(/[\s\u00a0]/g, "").replace(/,/g, "");
  const match = /(\d+(?:\.\d{1,2})?)/.exec(cleaned);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function currencyOf(text: string): string | null {
  for (const [pattern, code] of CURRENCY_SYMBOLS) if (pattern.test(text)) return code;
  return null;
}

// nopCommerce's stock words. `Low stock` is IN stock — a shop saying it has few
// left is saying it has some — and anything the vocabulary does not recognize
// stays null rather than being read as either.
function stockOf(text: string): boolean | null {
  const value = text.toLowerCase();
  if (/out of stock|sold out|unavailable/.test(value)) return false;
  if (/in stock|low stock|backorder|pre-?order/.test(value)) return true;
  return null;
}

// The unit half of a label: everything after its last " - ". Split on the LAST
// separator because a product name may contain one of its own (`Chef's Cut
// Short - Box of 25` has one, `La Gloria - Serie R - Pack of 5` has two) and the
// unit is always the tail.
function unitOf(label: string): string | null {
  const idx = label.lastIndexOf(" - ");
  if (idx === -1) return null;
  const tail = label.slice(idx + 3).trim();
  return tail.length > 0 ? tail : null;
}

function nopCommerceVariants(html: string): VariantPrice[] {
  const out: VariantPrice[] = [];
  const starts: Array<{ id: string; at: number; end: number }> = [];
  // A fresh RegExp per call — the module-level literal carries `g`, and a shared
  // stateful matcher across pages is a bug this repo has already paid for.
  const lines = new RegExp(VARIANT_LINE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = lines.exec(html)) !== null) {
    starts.push({ id: match[1]!, at: match.index, end: lines.lastIndex });
  }

  for (let i = 0; i < starts.length; i++) {
    const line = starts[i]!;
    const chunk = html.slice(line.end, starts[i + 1]?.at ?? html.length);
    const nameMatch = VARIANT_NAME.exec(chunk);
    if (!nameMatch) continue;
    const label = decode(nameMatch[1]!);
    if (!label) continue;

    // Paired BY ID, not by position — see the header.
    const priceMatch = new RegExp(`<span[^>]*id="price-value-${line.id}"[^>]*>([\\s\\S]*?)</span>`, "i").exec(chunk);
    const stockMatch = new RegExp(
      `<span[^>]*id="stock-availability-value-${line.id}"[^>]*>([\\s\\S]*?)</span>`,
      "i",
    ).exec(chunk);
    const priceText = priceMatch ? decode(priceMatch[1]!) : "";

    out.push({
      label,
      unit: unitOf(label),
      priceCents: priceText ? priceTextToCents(priceText) : null,
      currency: priceText ? currencyOf(priceText) : null,
      inStock: stockMatch ? stockOf(decode(stockMatch[1]!)) : null,
    });
  }
  return out;
}

// The declared HTML price rows on a product page. Empty for an adapter that
// declares no source — and empty, too, for a SIMPLE product at a shop that does
// declare one: that page has no variant list and its structured price is real,
// which is exactly the case that must be left alone.
export function extractVariantPrices(html: string, source: VariantPriceSource | undefined): VariantPrice[] {
  if (source !== "nopcommerce-variant-overview") return [];
  return nopCommerceVariants(html);
}
