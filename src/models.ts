export interface IPhoneModelMeta {
  key: string;
  label: string;
  model: string;
  software: string;
  lensModel: string;
  fNumber: number;
  iso: number;
  exposureTimeStr: string;
  focalLength: number;
  focalLengthIn35mm: number;
  /** Megapixels reported in EXIF and used to pick output resolution. */
  megapixels: number;
}

/** Normal (non-Pro) iPhones report 12 MP — matches default iPhone Photo mode. */
const MP_NORMAL = 12;
/** Pro and Pro Max iPhones report 24 MP — ProRAW-style higher-res output. */
const MP_PRO = 24;

function lens(modelName: string, focal: number, fnum: number): string {
  return `${modelName} back camera ${focal}mm f/${fnum}`;
}

export const IPHONE_MODELS: IPhoneModelMeta[] = [
  {
    key: "ip14",
    label: "iPhone 14",
    model: "iPhone 14",
    software: "16.6",
    lensModel: lens("iPhone 14", 5.7, 1.5),
    fNumber: 1.5,
    iso: 100,
    exposureTimeStr: "1/120",
    focalLength: 5.7,
    focalLengthIn35mm: 26,
    megapixels: MP_NORMAL,
  },
  {
    key: "ip14p",
    label: "iPhone 14 Pro",
    model: "iPhone 14 Pro",
    software: "16.6",
    lensModel: lens("iPhone 14 Pro", 6.86, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.86,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
  {
    key: "ip15",
    label: "iPhone 15",
    model: "iPhone 15",
    software: "17.3",
    lensModel: lens("iPhone 15", 5.96, 1.6),
    fNumber: 1.6,
    iso: 80,
    exposureTimeStr: "1/200",
    focalLength: 5.96,
    focalLengthIn35mm: 26,
    megapixels: MP_NORMAL,
  },
  {
    key: "ip15p",
    label: "iPhone 15 Pro",
    model: "iPhone 15 Pro",
    software: "17.3",
    lensModel: lens("iPhone 15 Pro", 6.86, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.86,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
  {
    key: "ip15pm",
    label: "iPhone 15 Pro Max",
    model: "iPhone 15 Pro Max",
    software: "17.3",
    lensModel: lens("iPhone 15 Pro Max", 6.86, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.86,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
  {
    key: "ip16",
    label: "iPhone 16",
    model: "iPhone 16",
    software: "18.1",
    lensModel: lens("iPhone 16", 5.96, 1.6),
    fNumber: 1.6,
    iso: 80,
    exposureTimeStr: "1/200",
    focalLength: 5.96,
    focalLengthIn35mm: 26,
    megapixels: MP_NORMAL,
  },
  {
    key: "ip16p",
    label: "iPhone 16 Pro",
    model: "iPhone 16 Pro",
    software: "18.1",
    lensModel: lens("iPhone 16 Pro", 6.765, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.765,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
  {
    key: "ip16pm",
    label: "iPhone 16 Pro Max",
    model: "iPhone 16 Pro Max",
    software: "18.1",
    lensModel: lens("iPhone 16 Pro Max", 6.765, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.765,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
  {
    key: "ip17",
    label: "iPhone 17",
    model: "iPhone 17",
    software: "19.0",
    lensModel: lens("iPhone 17", 5.96, 1.6),
    fNumber: 1.6,
    iso: 80,
    exposureTimeStr: "1/200",
    focalLength: 5.96,
    focalLengthIn35mm: 26,
    megapixels: MP_NORMAL,
  },
  {
    key: "ip17p",
    label: "iPhone 17 Pro",
    model: "iPhone 17 Pro",
    software: "19.0",
    lensModel: lens("iPhone 17 Pro", 6.86, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.86,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
  {
    key: "ip17pm",
    label: "iPhone 17 Pro Max",
    model: "iPhone 17 Pro Max",
    software: "19.0",
    lensModel: lens("iPhone 17 Pro Max", 6.86, 1.78),
    fNumber: 1.78,
    iso: 64,
    exposureTimeStr: "1/250",
    focalLength: 6.86,
    focalLengthIn35mm: 24,
    megapixels: MP_PRO,
  },
];

export function findModel(key: string): IPhoneModelMeta | undefined {
  return IPHONE_MODELS.find((m) => m.key === key);
}

export function modelByLabel(label: string): IPhoneModelMeta | undefined {
  return IPHONE_MODELS.find((m) => m.label === label);
}
