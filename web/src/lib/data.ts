import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export type Category = { id: string; name: string; kind: "spectrum" | "tags"; description: string | null; enabled: boolean; sort: number };
export type Subclass = { id: string; category_id: string; name: string; definition: string; anchor_order: number; pixel_weight: number };
export type ImageNode = {
  id: string;
  filename: string | null;
  thumbUrl: string;
  fullUrl: string;
  width: number | null;
  height: number | null;
  umap: [number, number];
  scores: Record<string, number>; // subclass id -> combined 0..1
};
export type Dataset = { categories: Category[]; subclasses: Subclass[]; images: ImageNode[] };

const PAGE = 1000;

type ImageRow = {
  id: string;
  filename: string | null;
  thumb_path: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  umap_x: number | null;
  umap_y: number | null;
};

/**
 * Read every row in pages. `order` must end in unique column(s): Postgres row order isn't
 * stable between requests, so unordered pages can skip or repeat rows. Stops on an empty
 * page, so a server row cap below PAGE can't silently truncate the result.
 */
async function fetchAll<T>(table: string, columns: string, opts: { order: string[]; eq?: [string, string] }): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; ) {
    let q = supabase.from(table).select(columns);
    if (opts.eq) q = q.eq(opts.eq[0], opts.eq[1]);
    for (const col of opts.order) q = q.order(col);
    const { data, error } = await q.range(start, start + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...(data as T[]));
    start += data.length;
  }
}
export async function loadDataset(): Promise<Dataset> {
  const [categories, subclasses, images, scores] = await Promise.all([
    fetchAll<Category>("categories", "*", { order: ["sort", "id"] }),
    fetchAll<Subclass>("subclasses", "id,category_id,name,definition,anchor_order,pixel_weight", { order: ["anchor_order", "id"] }),
    fetchAll<ImageRow>("images", "id,filename,thumb_path,storage_path,width,height,umap_x,umap_y", { order: ["created_at", "id"] }),
    fetchAll<{ image_id: string; subclass_id: string; value: number }>("scores", "image_id,subclass_id,value", {
      eq: ["source", "combined"],
      order: ["image_id", "subclass_id"],
    }),
  ]);

  const byImage = new Map<string, Record<string, number>>();
  for (const s of scores) {
    if (!byImage.has(s.image_id)) byImage.set(s.image_id, {});
    byImage.get(s.image_id)![s.subclass_id] = s.value;
  }
  const bucket = supabase.storage.from("images");
  return {
    categories,
    subclasses,
    images: images.map((r) => ({
      id: r.id,
      filename: r.filename,
      thumbUrl: bucket.getPublicUrl(r.thumb_path).data.publicUrl,
      fullUrl: bucket.getPublicUrl(r.storage_path).data.publicUrl,
      width: r.width,
      height: r.height,
      umap: [r.umap_x ?? 0, r.umap_y ?? 0],
      scores: byImage.get(r.id) ?? {},
    })),
  };
}
