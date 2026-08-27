import qrcode from "qrcode-generator";

export function qrSvgTag(value: string, cellSize: number) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}
