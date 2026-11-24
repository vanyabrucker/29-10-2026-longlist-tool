"""Shared platforms: sites where many unrelated companies have a page.

A link to one of them (instagram.com/acme, linktr.ee/acme) says nothing about
which company it is: cut to its domain, every such page would look like the
same website, so rows would be taken for duplicates and merged into one
company. Such a value is not a company website; it is never stored, matched
or used to spot duplicates.
"""

import re

# Exact hosts or parent domains (a subdomain counts: m.facebook.com,
# acme.wixsite.com). Lower case, without "www.".
SHARED = frozenset({
    # social networks and messaging
    "facebook.com", "fb.com", "fb.me", "instagram.com", "linkedin.com", "lnkd.in",
    "twitter.com", "x.com", "threads.net", "tiktok.com", "youtube.com", "youtu.be",
    "pinterest.com", "snapchat.com", "xing.com", "t.me", "wa.me", "whatsapp.com",
    "vimeo.com", "medium.com", "github.com",
    # link-in-bio pages and short links
    "linktr.ee", "beacons.ai", "bio.link", "bit.ly", "goo.gl", "tinyurl.com",
    # site builders' and hosts' shared domains
    "sites.google.com", "business.site", "g.page", "wixsite.com", "wix.com",
    "weebly.com", "jimdosite.com", "jimdo.com", "squarespace.com", "wordpress.com",
    "blogspot.com", "webnode.com", "strikingly.com", "carrd.co", "notion.site",
    # directories and review sites
    "google.com", "yelp.com", "tripadvisor.com", "calendly.com",
})


_LONGEST_FIRST = sorted(SHARED, key=len, reverse=True)


def shared_host(domain: str) -> str | None:
    """The shared platform a domain belongs to, or None."""
    d = domain.lower().removeprefix("www.")
    # The most specific entry wins (sites.google.com before google.com).
    return next((h for h in _LONGEST_FIRST if d == h or d.endswith("." + h)), None)


_LINKEDIN_COMPANY = re.compile(
    r"^(?:https?://)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com/company/[^/?#\s]+", re.IGNORECASE)


def linkedin_company(raw: str) -> str | None:
    """A LinkedIn company page given as a website ("linkedin.com/company/acme"),
    as a URL for the LinkedIn data point; None for anything else."""
    m = _LINKEDIN_COMPANY.match(str(raw).strip())
    if not m:
        return None
    url = m.group(0)
    return url if url.lower().startswith("http") else "https://" + url
