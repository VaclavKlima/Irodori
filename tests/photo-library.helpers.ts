import { PhotoLibrary as ProductionPhotoLibrary } from '../src/main/library'
import { CatalogWriter } from '../src/main/catalog/writer'
import { resolve } from 'node:path'

/** Direct-TS service fixtures use the real worker built beside the application bundle. */
export class PhotoLibrary extends ProductionPhotoLibrary {
  private readonly catalogOwner: { value?: CatalogWriter }
  constructor(...args: ConstructorParameters<typeof ProductionPhotoLibrary>) {
    const owner: { value?: CatalogWriter } = {},
      create = args[17]
    args[17] = (path) =>
      (owner.value = create
        ? create(path)
        : new CatalogWriter(path, undefined, resolve('out/main/catalog-worker.js')))
    super(...args)
    this.catalogOwner = owner
  }
  get catalogCommands(): CatalogWriter {
    if (!this.catalogOwner.value) throw new Error('The fixture catalog owner is not open.')
    return this.catalogOwner.value
  }
}
