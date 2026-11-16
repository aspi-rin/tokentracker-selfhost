// Re-encode a small, square raster thumbnail before sending it to the instance.
export async function prepareAvatarFile(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error("invalid-avatar");
  }
  const image = await createImageBitmap(file);
  try {
    if (!image.width || !image.height || image.width * image.height > 20000000) throw new Error("invalid-avatar");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const side = Math.min(image.width, image.height);
    canvas.getContext("2d").drawImage(image, (image.width-side)/2, (image.height-side)/2, side, side, 0, 0, 256, 256);
    const data = canvas.toDataURL("image/webp", 0.85);
    if (data.length > 87408) throw new Error("invalid-avatar");
    return data;
  } finally { image.close(); }
}
