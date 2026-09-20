export interface LoadedFont {
  family: string;
  weight: string;
  style: string;
  status: string;
}
/** what a @font-face rule says, from the cssom or from a parsed body: both readers produce this. */
export interface FontFaceSource {
  family: string;
  weight: string;
  style: string;
  urls: string[];
}
export interface FontEntry {
  family: string;
  weight: string;
  style: string;
  status: string;
  file: string | null;
  url: string | null;
}

/** a font-weight descriptor as a numeric range: `bold` is 700, `100 900` spans, `normal` and empty are 400. */
export function weightRange(weight: string): [number, number] {
  const w = weight.trim().toLowerCase();
  if (w === '' || w === 'normal') return [400, 400];
  if (w === 'bold') return [700, 700];
  const nums = w
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length === 1) return [nums[0]!, nums[0]!];
  if (nums.length >= 2) return [Math.min(nums[0]!, nums[1]!), Math.max(nums[0]!, nums[1]!)];
  return [400, 400];
}

function plainFamily(s: string): string {
  return s
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

/** `oblique 10deg` and `italic` are styles; empty is `normal`. */
function plainStyle(s: string): string {
  const t = s.trim().toLowerCase();
  return t === '' ? 'normal' : t.split(/\s+/)[0]!;
}

/**
 * the @font-face rules that could have supplied a loaded font: same family and style, and a
 * weight range that holds the loaded weight. a font the page reports loaded says nothing
 * about where it came from; the faces do.
 */
export function matchingFaces(font: LoadedFont, faces: FontFaceSource[]): FontFaceSource[] {
  const family = plainFamily(font.family);
  const [lo, hi] = weightRange(font.weight);
  return faces.filter((face) => {
    if (plainFamily(face.family) !== family) return false;
    if (plainStyle(face.style) !== plainStyle(font.style)) return false;
    const [flo, fhi] = weightRange(face.weight);
    return flo <= hi && fhi >= lo;
  });
}

/** one face per family, weight, style and source list, first occurrence kept */
export function uniqueFaces(faces: FontFaceSource[]): FontFaceSource[] {
  const seen = new Set<string>();
  return faces.filter((f) => {
    const key = `${plainFamily(f.family)}|${f.weight}|${plainStyle(f.style)}|${f.urls.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * each loaded font to the captured file that backs it: a face with the same family and
 * style whose weight range holds the loaded weight, then the first of its src urls the store
 * has (looked up without a fragment: `#iefix` never reaches the server). an unmapped face
 * gets null; whether that is fatal is the caller's call.
 */
export function mapFonts(
  loaded: LoadedFont[],
  faces: FontFaceSource[],
  fileFor: (url: string) => string | null,
): FontEntry[] {
  return loaded.map((f) => {
    const family = f.family.replace(/^["']|["']$/g, '');
    for (const face of matchingFaces(f, faces)) {
      for (const url of face.urls) {
        const file = fileFor(url.split('#')[0]!);
        if (file) return { family, weight: f.weight, style: f.style, status: f.status, file, url };
      }
    }
    return { family, weight: f.weight, style: f.style, status: f.status, file: null, url: null };
  });
}
