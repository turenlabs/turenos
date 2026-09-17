//! `image_exif` — EXIF/TIFF tag extraction via `kamadak-exif` over the
//! container-located TIFF block: GPS coordinates, camera fields, thumbnail
//! presence (reported as size+SHA-256; bytes only when <= 256 KiB).

use serde::Deserialize;
use sha2::Digest;

use crate::model::{parse_image, Limits};
use crate::{base64, clean, hex, Fail, OpResult, MAX_RESULTS, MAX_STRING_CHARS};

/// Never return more thumbnail bytes than this; larger thumbnails are
/// reported as size + SHA-256 + offset only.
const MAX_THUMBNAIL_BYTES: u64 = 256 * 1024;
const DEFAULT_MAX_FIELDS: usize = 512;

#[derive(Default, Deserialize)]
pub(crate) struct ExifOptions {
    #[serde(default)]
    max_fields: Option<usize>,
}

pub(crate) fn run(bytes: &[u8], options: &ExifOptions) -> OpResult {
    let limits = Limits {
        collect_text: false,
        ..Limits::default()
    };
    let report = parse_image(bytes, &limits)?;
    let max_fields = options
        .max_fields
        .unwrap_or(DEFAULT_MAX_FIELDS)
        .clamp(1, MAX_RESULTS);

    let (range, source) = match report.exif {
        Some(range) => (range, format!("{}:exif", report.format)),
        None => {
            return Ok(serde_json::json!({
                "schema_version": 1,
                "format": report.format,
                "exif_present": false,
            }))
        }
    };
    let start = range.offset as usize;
    let end = start.saturating_add(range.length as usize).min(bytes.len());
    let tiff = bytes
        .get(start..end)
        .ok_or_else(|| Fail::new("invalid_exif").with("detail", "exif range out of bounds"))?;

    let reader_result = exif::Reader::new()
        .continue_on_error(true)
        .read_raw(tiff.to_vec());
    let (exif, warnings) = match reader_result {
        Ok(exif) => (exif, Vec::new()),
        Err(exif::Error::PartialResult(partial)) => {
            let (exif, errors) = partial.into_inner();
            (
                exif,
                errors
                    .iter()
                    .take(8)
                    .map(|error| clean(&error.to_string(), 256))
                    .collect::<Vec<String>>(),
            )
        }
        Err(error) => {
            return Err(Fail::new("invalid_exif")
                .with("detail", clean(&error.to_string(), MAX_STRING_CHARS)))
        }
    };

    let mut fields = Vec::new();
    let mut fields_total = 0usize;
    let mut truncated = false;
    for field in exif.fields() {
        fields_total += 1;
        if fields.len() >= max_fields {
            truncated = true;
            continue;
        }
        fields.push(serde_json::json!({
            "tag": field.tag.to_string(),
            "ifd": field.ifd_num.index(),
            "value": field_text(field),
        }));
    }

    let get = |tag: exif::Tag| -> Option<String> {
        exif.fields()
            .find(|field| field.tag == tag)
            .map(field_text)
    };
    let gps = gps_decimal(&exif);
    let thumbnail = thumbnail_info(&exif, bytes, start);

    Ok(serde_json::json!({
        "schema_version": 1,
        "format": report.format,
        "exif_present": true,
        "source": source,
        "tiff_offset": range.offset,
        "tiff_length": range.length,
        "make": get(exif::Tag::Make),
        "model": get(exif::Tag::Model),
        "software": get(exif::Tag::Software),
        "datetime": get(exif::Tag::DateTime),
        "datetime_original": get(exif::Tag::DateTimeOriginal),
        "artist": get(exif::Tag::Artist),
        "copyright": get(exif::Tag::Copyright),
        "image_description": get(exif::Tag::ImageDescription),
        "orientation": get(exif::Tag::Orientation),
        "lens_model": get(exif::Tag::LensModel),
        "gps": gps,
        "thumbnail": thumbnail,
        "fields": fields,
        "fields_total": fields_total,
        "warnings": warnings,
        "truncated": truncated,
    }))
}

/// Clean string for a field: `display_value` renders ASCII values with
/// surrounding quotes, so unwrap `Value::Ascii` directly and fall back to the
/// display rendering for numeric types.
fn field_text(field: &exif::Field) -> String {
    if let exif::Value::Ascii(values) = &field.value {
        let joined: Vec<String> = values
            .iter()
            .map(|value| {
                String::from_utf8_lossy(value)
                    .trim_end_matches('\0')
                    .to_string()
            })
            .collect();
        return clean(&joined.join(" "), MAX_STRING_CHARS);
    }
    clean(&field.display_value().to_string(), MAX_STRING_CHARS)
}

/// GPS DMS rationals -> signed decimal degrees.
fn gps_decimal(exif: &exif::Exif) -> serde_json::Value {
    let find = |tag: exif::Tag| exif.fields().find(|field| field.tag == tag);
    let coord = |value_tag: exif::Tag, ref_tag: exif::Tag| -> Option<f64> {
        let field = find(value_tag)?;
        let dms = match &field.value {
            exif::Value::Rational(parts) if parts.len() >= 3 => parts,
            _ => return None,
        };
        let rational = |r: &exif::Rational| -> f64 {
            if r.denom == 0 {
                0.0
            } else {
                r.num as f64 / r.denom as f64
            }
        };
        let mut value = rational(&dms[0]) + rational(&dms[1]) / 60.0 + rational(&dms[2]) / 3600.0;
        if let Some(reference) = find(ref_tag) {
            let text = reference.display_value().to_string();
            if text.starts_with('S') || text.starts_with('W') {
                value = -value;
            }
        }
        Some(value)
    };
    let latitude = coord(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef);
    let longitude = coord(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef);
    let altitude = find(exif::Tag::GPSAltitude).and_then(|field| {
        if let exif::Value::Rational(parts) = &field.value {
            parts.first().map(|r| {
                let meters = if r.denom == 0 { 0.0 } else { r.num as f64 / r.denom as f64 };
                let below = matches!(
                    find(exif::Tag::GPSAltitudeRef).map(|f| &f.value),
                    Some(exif::Value::Byte(b)) if b.first() == Some(&1)
                );
                if below { -meters } else { meters }
            })
        } else {
            None
        }
    });
    match (latitude, longitude) {
        (Some(lat), Some(lon)) => serde_json::json!({
            "latitude": lat,
            "longitude": lon,
            "altitude_meters": altitude,
        }),
        _ => serde_json::Value::Null,
    }
}

/// Thumbnail bytes live in IFD1 at JPEGInterchangeFormat/Length, offsets
/// relative to the TIFF header. Presence is always reported; bytes only when
/// the region is in bounds and <= 256 KiB, else size + SHA-256.
fn thumbnail_info(exif: &exif::Exif, bytes: &[u8], tiff_base: usize) -> serde_json::Value {
    let ifd1 = |tag: exif::Tag| -> Option<u64> {
        exif.fields()
            .find(|field| field.tag == tag && field.ifd_num == exif::In::THUMBNAIL)
            .and_then(|field| match &field.value {
                exif::Value::Long(v) => v.first().map(|n| *n as u64),
                exif::Value::Short(v) => v.first().map(|n| *n as u64),
                _ => None,
            })
    };
    let (offset, length) = match (
        ifd1(exif::Tag::JPEGInterchangeFormat),
        ifd1(exif::Tag::JPEGInterchangeFormatLength),
    ) {
        (Some(offset), Some(length)) => (offset, length),
        _ => return serde_json::json!({ "present": false }),
    };
    let start = tiff_base.saturating_add(offset as usize);
    let end = start.saturating_add(length as usize);
    let region = bytes.get(start..end);
    match region {
        Some(data) => {
            let digest = sha2::Sha256::digest(data);
            let mut value = serde_json::json!({
                "present": true,
                "offset": start,
                "length": length,
                "sha256": hex(&digest),
            });
            if length <= MAX_THUMBNAIL_BYTES {
                value["data_base64"] = base64(data).into();
            }
            value
        }
        None => serde_json::json!({
            "present": true,
            "offset": start,
            "length": length,
            "out_of_bounds": true,
        }),
    }
}
