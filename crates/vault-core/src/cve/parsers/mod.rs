//! Lock-file parsers. Each parser is responsible for turning a raw
//! lock-file body into a [`super::DependencyPackage`] list with the
//! `npm` OSV ecosystem string.

pub mod package_lock;
pub mod yarn_lock;
