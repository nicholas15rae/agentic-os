"""Exceptions shared by the package; each maps to one CLI exit code."""

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_CONFIG = 2
EXIT_DEFERRED = 75


class MemoryScrollsError(Exception):
    """Base class."""


class ConfigError(MemoryScrollsError):
    """Bad configuration or validation failure: exit 2."""


class HubWriteRefused(ConfigError):
    """A write target resolves under the read-only C:\\ai-hub tree (exit 2, like any config error)."""


class Deferred(MemoryScrollsError):
    """Not now (busy GPU, no loaded model, another run holds the lock): exit 75."""


class BookingRefused(MemoryScrollsError):
    """A Booking workspace (my-workspace / booking) was about to be touched."""


class ArchiveError(MemoryScrollsError):
    """Archive write or verification failed. Nothing downstream may run."""


class ScrollError(MemoryScrollsError):
    """A scroll file or frontmatter is invalid."""
