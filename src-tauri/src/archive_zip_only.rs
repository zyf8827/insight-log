// temporary zip-focused helper before unified archive module
pub fn sniff_zip(magic: &[u8]) -> bool {
    magic.starts_with(&[0x50, 0x4B])
}
