import { Uuid } from "../primitives";
import { z } from "../z";

// Endpoints map a failed parse of this header to `idempotency_key_required`.
export const IdempotencyKeyHeader = z.object({ "idempotency-key": Uuid });
