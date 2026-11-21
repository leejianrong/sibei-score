import type { Id } from '@sibei/model';
import type { ScoreImporter } from '../imports/runner.js';
import type { Owner, ScoreLibrary } from '../store/repository.js';

/**
 * No import lands a draft for an account that is gone (SIB2-202).
 *
 * Account deletion erases content first and the identity last (`auth/account.ts`), so an import still
 * running when the button is pressed can finish after its owner's rows are deleted and write a score for a
 * user who no longer exists: an orphan nothing can reach or delete. All three landings (a photo, a
 * NoteEvents file, an audio result) go through the applier's one server-only `import`, so this wraps that.
 *
 * It checks before the write (a gone account writes nothing) and again after it, deleting the draft it
 * just wrote if the account vanished in between, and it fails the job with `OwnerGoneError`. The other
 * half of the guarantee is in `auth/account.ts`: the content is erased once more after the identity row is
 * deleted, which catches a landing that passed both checks before the deletion and committed after the
 * first erase. The checks are not one transaction with the write (the stores have no foreign key from a
 * score to a user: a local install has no users), so the pair of them plus the second erase is what closes
 * the window.
 */
export class OwnerGoneError extends Error {
  constructor() {
    super('the account was deleted while this import was running, so nothing was saved');
    this.name = 'OwnerGoneError';
  }
}

export function guardLanding(
  importer: ScoreImporter,
  ownerExists: (owner: Owner) => Promise<boolean>,
  library: Pick<ScoreLibrary, 'delete'>,
): ScoreImporter {
  return {
    async import(owner, document) {
      if (!(await ownerExists(owner))) throw new OwnerGoneError();
      const landed = await importer.import(owner, document);
      if (!(await ownerExists(owner))) {
        await library.delete(owner, landed.scoreId as Id);
        throw new OwnerGoneError();
      }
      return landed;
    },
  };
}
