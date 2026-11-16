// Public avatars are bounded raster thumbnails, without external URL fetches.
export function validPublicAvatar(value: string): boolean {
  if (value.length > 90000) return false;
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  try {
    const raw = atob(match[2]);
    if (raw.length > 65536) return false;
    const b = (i: number) => raw.charCodeAt(i);
    const be16 = (i: number) => b(i)*256+b(i+1);
    const be32 = (i: number) => be16(i)*65536+be16(i+2);
    const le24 = (i: number) => b(i)+b(i+1)*256+b(i+2)*65536;
    let width = 0, height = 0;
    if (match[1] === "png" && raw.length>=33 && raw.startsWith("\x89PNG\r\n\x1a\n") && raw.slice(12,16) === "IHDR") {
      width = be32(16); height = be32(20);
    } else if (match[1] === "webp" && raw.length>=30 && raw.startsWith("RIFF") && raw.slice(8,12) === "WEBP") {
      const kind = raw.slice(12,16);
      if (kind === "VP8 " && raw.slice(23,26) === "\x9d\x01\x2a") {
        width = (b(26)+256*b(27))&16383; height = (b(28)+256*b(29))&16383;
      } else if (kind === "VP8L" && b(20) === 47) {
        width = 1+((b(21)+256*b(22))&16383);
        height = 1+(((b(22)>>6)+4*b(23)+1024*b(24))&16383);
      } else if (kind === "VP8X" && !(b(20)&2)) {
        width = 1+le24(24); height = 1+le24(27);
      }
    } else if (match[1] === "jpeg" && raw.startsWith("\xff\xd8\xff")) {
      for (let i=2; i+9<raw.length;) {
        if (b(i)!==255) break;
        const marker=b(i+1), size=be16(i+2);
        if (size<2 || i+2+size>raw.length) break;
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
          height=be16(i+5); width=be16(i+7); break;
        }
        i+=2+size;
      }
    }
    return width>0 && height>0 && width<=512 && height<=512;
  } catch { return false; }
}
