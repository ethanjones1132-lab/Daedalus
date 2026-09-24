import {
  OrchestrationAdmissionAbortedError,
  OrchestrationAdmissionDeadlineExceededError,
  type AdmissionLease,
} from "./admission-controller";

export async function acquireAdmissionForStream(options: {
  acquire: () => Promise<AdmissionLease>;
  onDeadline: (error: OrchestrationAdmissionDeadlineExceededError) => Promise<void>;
  onCancelled: () => Promise<void>;
}): Promise<AdmissionLease | undefined> {
  try {
    return await options.acquire();
  } catch (error) {
    if (error instanceof OrchestrationAdmissionDeadlineExceededError) {
      await options.onDeadline(error);
      return undefined;
    }
    if (error instanceof OrchestrationAdmissionAbortedError) {
      await options.onCancelled();
      return undefined;
    }
    throw error;
  }
}
