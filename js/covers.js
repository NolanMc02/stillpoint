// Store a small, local raster thumbnail rather than the EPUB's original image.
export const validCover = value => typeof value === 'string' && value.length < 600000
  && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;

export async function makeCover(blob) {
  if (!blob?.size || blob.size > 16 * 1024 * 1024) throw new Error('Choose a cover image smaller than 16 MB.');
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve; image.onerror = () => reject(new Error('This cover image could not be opened.'));
      image.src = url;
    });
    const scale = Math.min(1, 360 / image.naturalWidth, 540 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#f7f4eb'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return validCover(canvas.toDataURL('image/jpeg', .82));
  } finally { URL.revokeObjectURL(url); }
}
