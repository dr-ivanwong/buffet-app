"""Publish an artefact to the app's API.

The engine holds the owner's Cognito refresh token in the environment,
the same trust domain that holds the broker login; a short-lived token
is minted per publish, and the artefact rides an authenticated PUT that
is idempotent by run date. Artefacts travel in this direction only: the
app renders and never writes sleeve data.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import httpx

DEFAULT_REGION = "ap-southeast-2"

# One authenticated PUT per artefact kind (integration plan §4); the API
# routes by the kind segment, and file names carry the same slug.
ARTEFACT_KINDS = ("pair-scan", "backtest", "daily", "weekly")
DEFAULT_KIND = "pair-scan"


def artefact_route(kind: str) -> str:
    if kind not in ARTEFACT_KINDS:
        raise PublishError(f"unknown artefact kind {kind!r}; one of {', '.join(ARTEFACT_KINDS)}")
    return f"/v1/pairs/artefacts/{kind}"


class PublishError(RuntimeError):
    pass


@dataclass(frozen=True)
class PublishConfig:
    api_url: str
    client_id: str
    refresh_token: str
    region: str = DEFAULT_REGION


def mint_token(config: PublishConfig, transport: httpx.BaseTransport | None = None) -> str:
    """Exchange the long-lived refresh token for a short-lived ID token
    at the user pool endpoint. The ID token is what the API's JWT
    authoriser validates (its audience is the app client)."""
    endpoint = f"https://cognito-idp.{config.region}.amazonaws.com/"
    with httpx.Client(transport=transport, timeout=30.0) as client:
        response = client.post(
            endpoint,
            headers={
                "Content-Type": "application/x-amz-json-1.1",
                "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
            },
            json={
                "AuthFlow": "REFRESH_TOKEN_AUTH",
                "ClientId": config.client_id,
                "AuthParameters": {"REFRESH_TOKEN": config.refresh_token},
            },
        )
    if response.status_code != 200:
        raise PublishError(
            f"token refresh failed ({response.status_code}); "
            "re-mint the refresh token per the runbook's pairs publish step"
        )
    token = response.json().get("AuthenticationResult", {}).get("IdToken")
    if not token:
        raise PublishError("token refresh returned no ID token; check the app client's auth flows")
    return str(token)


def publish_artefact(
    artefact_path: Path,
    config: PublishConfig,
    kind: str = DEFAULT_KIND,
    transport: httpx.BaseTransport | None = None,
) -> dict:
    """PUT the artefact file to the API; returns the stored run metadata."""
    route = artefact_route(kind)  # an unknown kind fails before any network
    token = mint_token(config, transport=transport)
    url = config.api_url.rstrip("/") + route
    with httpx.Client(transport=transport, timeout=60.0) as client:
        response = client.put(
            url,
            content=artefact_path.read_bytes(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
    if response.status_code != 200:
        detail = ""
        try:
            envelope = response.json()
            detail = f": {envelope['error']['code']}, {envelope['error']['message']}"
        except Exception:
            pass
        raise PublishError(f"publish failed ({response.status_code}){detail}")
    return response.json()


def newest_artefact(out_dir: Path, kind: str = DEFAULT_KIND) -> Path | None:
    """Run dates are ISO in the file name, so lexicographic order is
    chronological order and the newest sorts last."""
    candidates = sorted(out_dir.glob(f"{kind}-*.json"))
    return candidates[-1] if candidates else None
