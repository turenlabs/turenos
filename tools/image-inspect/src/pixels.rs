//! `image_pixel_stats` — OPTIONAL bounded pixel decode. Dimensions are read
//! from the container header first and images over the cap are refused before
//! any decode. Only PNG and JPEG are decodable (the `image` crate is built
//! with just those two features); other formats report `unsupported_format`.
//!
//! Statistics: a 16-bin luma histogram and per-channel means computed over a
//! deterministic strided sample of the decoded RGBA buffer.

use serde::Deserialize;

use crate::model::{detect_format, parse_image, Limits};
use crate::{Fail, OpResult};

/// Hard cap on either decoded dimension; a 4096x4096 RGBA decode is 64 MiB.
pub(crate) const MAX_DIMENSION: u32 = 4096;
/// Stride target: statistics sample at most this many pixels.
const MAX_SAMPLED_PIXELS: u64 = 4_000_000;

#[derive(Default, Deserialize)]
pub(crate) struct PixelOptions {
    #[serde(default)]
    max_dimension: Option<u32>,
}

pub(crate) fn run(bytes: &[u8], options: &PixelOptions) -> OpResult {
    let format = detect_format(bytes);
    let image_format = match format {
        "png" => image::ImageFormat::Png,
        "jpeg" => image::ImageFormat::Jpeg,
        _ => {
            return Err(Fail::new("unsupported_format")
                .with("detail", "pixel decode supports png and jpeg only")
                .with("format", format))
        }
    };
    let max_dimension = options
        .max_dimension
        .unwrap_or(MAX_DIMENSION)
        .clamp(1, MAX_DIMENSION);

    // Header-first dimension check: never decode a claimed-huge image.
    let limits = Limits {
        collect_text: false,
        max_regions: 64,
        ..Limits::default()
    };
    let report = parse_image(bytes, &limits)?;
    let (width, height) = match (report.width, report.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
        _ => {
            return Err(Fail::new("invalid_image")
                .with("detail", "no usable dimensions in image header"))
        }
    };
    if width > max_dimension as u64 || height > max_dimension as u64 {
        return Err(Fail::new("image_too_large")
            .with("width", width)
            .with("height", height)
            .with("limit", max_dimension));
    }

    let decoded = image::load_from_memory_with_format(bytes, image_format)
        .map_err(|error| Fail::new("decode_failed").with("detail", error.to_string()))?;
    let rgba = decoded.to_rgba8();
    let decoded_w = rgba.width() as u64;
    let decoded_h = rgba.height() as u64;
    let total_pixels = decoded_w.saturating_mul(decoded_h);
    if total_pixels == 0 {
        return Err(Fail::new("invalid_image").with("detail", "decoder produced no pixels"));
    }
    if decoded_w > max_dimension as u64 || decoded_h > max_dimension as u64 {
        return Err(Fail::new("image_too_large")
            .with("width", decoded_w)
            .with("height", decoded_h)
            .with("limit", max_dimension));
    }

    // Deterministic strided sampling keeps large images cheap.
    let step = (total_pixels / MAX_SAMPLED_PIXELS + 1) as usize;
    let pixels = rgba.as_raw();
    let mut histogram = [0u64; 16];
    let mut sums = [0u64; 4];
    let mut sampled = 0u64;
    let mut index = 0usize;
    while index < total_pixels as usize {
        let base = index * 4;
        if base + 4 > pixels.len() {
            break;
        }
        let (r, g, b, a) = (
            pixels[base] as u64,
            pixels[base + 1] as u64,
            pixels[base + 2] as u64,
            pixels[base + 3] as u64,
        );
        sums[0] += r;
        sums[1] += g;
        sums[2] += b;
        sums[3] += a;
        let luma = (299 * r + 587 * g + 114 * b) / 1000;
        histogram[((luma * 16) / 256).min(15) as usize] += 1;
        sampled += 1;
        index = index.saturating_add(step);
    }
    if sampled == 0 {
        return Err(Fail::new("invalid_image").with("detail", "no pixels sampled"));
    }

    Ok(serde_json::json!({
        "schema_version": 1,
        "format": format,
        "width": decoded_w,
        "height": decoded_h,
        "decoded": true,
        "sampled_pixels": sampled,
        "total_pixels": total_pixels,
        "sample_step": step,
        "luma_histogram": histogram,
        "channel_means": {
            "red": sums[0] as f64 / sampled as f64,
            "green": sums[1] as f64 / sampled as f64,
            "blue": sums[2] as f64 / sampled as f64,
            "alpha": sums[3] as f64 / sampled as f64,
        },
    }))
}
