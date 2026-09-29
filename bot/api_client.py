"""Bounded server-to-server upload with verified read-back and no speech requests."""
import asyncio
import json
import logging
import httpx

logger = logging.getLogger("vaami.uploads")

class SaveError(Exception):
    def __init__(self, message, retryable=True):
        super().__init__(message)
        self.retryable = retryable

class CallUploader:
    def __init__(self, settings, *, transport=None, sleep=asyncio.sleep):
        self.settings, self.transport, self.sleep = settings, transport, sleep

    async def save(self, frozen):
        try:
            async with asyncio.timeout(30):
                return await self._save(frozen)
        except TimeoutError:
            raise SaveError("Save timed out. The frozen call can be retried.") from None

    async def _save(self, frozen):
        expected = json.loads(frozen)
        call_id = expected["id"]
        base = self.settings.calls_api_url.rstrip("/")
        if not base or not self.settings.ingest_token:
            raise SaveError("Configure the Worker URL and ingestion token.", False)
        async with httpx.AsyncClient(transport=self.transport, timeout=4, trust_env=False,
                                     follow_redirects=False) as client:
            for attempt in range(3):
                try:
                    response = await asyncio.wait_for(client.post(base + "/calls",
                        headers={"Authorization": "Bearer " + self.settings.ingest_token,
                                 "Content-Type": "application/json"}, content=frozen.encode("utf-8")), 4)
                    self._check(response)
                    result = response.json()
                    if response.status_code not in (200, 201) or result.get("id") != call_id or not isinstance(result.get("duplicate"), bool):
                        raise SaveError("Worker returned an invalid save acknowledgement.")
                    # A success banner requires independently reading the saved data back.
                    detail = await asyncio.wait_for(client.get(base + "/calls/" + call_id), 4)
                    self._check(detail, reading=True)
                    stored = detail.json()
                    actual = {key: stored["call"][key] for key in expected if key not in ("transcripts", "metrics")}
                    actual.update(transcripts=stored["transcripts"], metrics=stored["metrics"])
                    if actual != expected:
                        raise SaveError("Saved data does not match the frozen call.", False)
                    logger.info("call_saved call_id=%s duplicate=%s attempt=%s", call_id, result["duplicate"], attempt + 1)
                    return
                except SaveError as error:
                    failure = error
                except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
                    failure = SaveError("Worker unavailable or returned an invalid response.")
                if not failure.retryable or attempt == 2:
                    raise failure
                logger.warning("save_retry call_id=%s attempt=%s", call_id, attempt + 1)
                await self.sleep(2 ** attempt)

    @staticmethod
    def _check(response, reading=False):
        status = response.status_code
        if 200 <= status < 300:
            return
        retryable = status in (408, 429) or status >= 500 or (reading and status == 404)
        if status == 429:
            # Do not retry sooner than a long/unknown server Retry-After instruction.
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                raise SaveError("Worker rate limit reached. Wait before retrying this call.", False)
        if status == 409:
            raise SaveError("This call ID already has different data. The stored call was not overwritten.", False)
        raise SaveError(f"Worker rejected the save (HTTP {status}). Check the Worker and ingestion configuration.", retryable)
