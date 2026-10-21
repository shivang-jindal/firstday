pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

// FIXME: handle overflow
pub fn add_checked(a: i32, b: i32) -> Option<i32> {
    a.checked_add(b)
}
