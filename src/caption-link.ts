export const LINK_PLACEHOLDER = "{link}";

/**
 * The first link with a path in a post caption that points at the allowed host
 * (with or without a scheme, with or without www). Anything else is ignored, so a
 * lookalike domain or a link to another site never reaches a DM.
 */
export function extractCaptionLink(caption: string | null | undefined, host: string | undefined): string | null {
  const allowed = host?.trim().toLowerCase().replace(/^www\./, "");
  if (!caption || !allowed) return null;

  for (const raw of caption.split(/\s+/)) {
    const token = raw.replace(/^[(<["'“‘]+/, "").replace(/[.,;:!?)>\]"'”’…]+$/, "");
    if (!token || token.startsWith("@") || !token.toLowerCase().includes(allowed)) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`);
      const hostname = url.hostname.toLowerCase();
      if (url.username || url.password || (hostname !== allowed && hostname !== `www.${allowed}`)) continue;
      // A bare "keukenliefde.nl" is the site, not this recipe: keep looking.
      if (url.pathname === "/" && !url.search) continue;
      url.protocol = "https:";
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export function fillLink(text: string, link: string | null): string {
  return text.split(LINK_PLACEHOLDER).join(link ?? "");
}
