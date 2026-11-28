"""engine/bizops.py: one shared prompt + only the tagged business's section; refusals; scope-bleed
check against other businesses' names / aliases; CRLF drafts; and the real draft parses."""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import bizops as bz  # noqa: E402

DRAFT = """# Draft

## Shared part (always sent)

```text
You are Biz Ops for {business_name} (tag `{business}`).

{business_section}
```

## Business sections

### `trades_contracting`: Trades

```text
TRADES: masonry jobs and quotes.
```

### `supplements_ecom`: Supplements

```text
SUPPLEMENTS: orders and inventory.
```

### `leaky`: Leaky

```text
LEAKY: also check the masonry crew.
```
"""

REG = [
    {"businessId": "trades_contracting", "displayName": "Trades & Contracting", "aliases": ["masonry", "contracting"], "status": "active"},
    {"businessId": "supplements_ecom", "displayName": "Supplements & E-Commerce", "aliases": ["bf supplements", "ecom"], "status": "active"},
    {"businessId": "acting", "displayName": "Acting", "aliases": ["auditions"], "status": "provisioning"},
    {"businessId": "leaky", "displayName": "Leaky Co", "aliases": [], "status": "active"},
]


class BizOpsTests(unittest.TestCase):
    def test_only_the_tagged_section(self):
        p = bz.build_prompt("supplements_ecom", REG, DRAFT)
        self.assertIn("Biz Ops for Supplements & E-Commerce (tag `supplements_ecom`)", p)
        self.assertIn("SUPPLEMENTS: orders", p)
        self.assertNotIn("TRADES", p)
        self.assertNotIn("{business", p)

    def test_refusals(self):
        for tag in (None, "", "nope"):
            with self.assertRaises(bz.BizOpsRefused):
                bz.build_prompt(tag, REG, DRAFT)
        with self.assertRaises(bz.BizOpsRefused) as c:
            bz.build_prompt("acting", REG, DRAFT)
        self.assertIn("provisioning", str(c.exception))
        with self.assertRaises(bz.BizOpsRefused) as c:  # allowed, but the draft has no Acting section
            bz.build_prompt("acting", REG, DRAFT, allow_provisioning=True)
        self.assertIn("no section", str(c.exception))

    def test_scope_bleed_is_refused(self):
        with self.assertRaises(bz.BizOpsRefused) as c:
            bz.build_prompt("leaky", REG, DRAFT)
        self.assertIn("trades_contracting", str(c.exception))

    def test_crlf_draft(self):
        p = bz.build_prompt("trades_contracting", REG, DRAFT.replace("\n", "\r\n"))
        self.assertIn("TRADES: masonry", p)

    def test_the_real_draft_has_all_three_sections(self):
        shared, sections = bz.parse_draft(Path(bz.DRAFT).read_text(encoding="utf-8"))
        self.assertIn("{business_section}", shared)
        self.assertEqual(sorted(sections), ["acting", "supplements_ecom", "trades_contracting"])


if __name__ == "__main__":
    unittest.main()
