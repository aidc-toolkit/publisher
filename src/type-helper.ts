/**
 * Create an object with omitted or picked entries.
 *
 * @param omitting
 * True if omitting.
 *
 * @param o
 * Object.
 *
 * @param keys
 * Keys to omit or pick.
 *
 * @returns
 * Edited object.
 */
function omitOrPick<Omitting extends boolean, T extends object, K extends keyof T>(omitting: Omitting, o: T, ...keys: K[]): Omitting extends true ? Omit<T, K> : Pick<T, K> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Key and value types are known.
    return Object.fromEntries(Object.entries(o).filter(([key]) => keys.includes(key as K) !== omitting)) as ReturnType<typeof omitOrPick<Omitting, T, K>>;
}

/**
 * Create an object with omitted entries.
 *
 * @param o
 * Object.
 *
 * @param keys
 * Keys to omit.
 *
 * @returns
 * Edited object.
 */
export function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
    return omitOrPick(true, o, ...keys);
}

/**
 * Create an object with picked entries.
 *
 * @param o
 * Object.
 *
 * @param keys
 * Keys to pick.
 *
 * @returns
 * Edited object.
 */
export function pick<T extends object, K extends keyof T>(o: T, ...keys: K[]): Pick<T, K> {
    return omitOrPick(false, o, ...keys);
}

/**
 * Cast a property as a more narrow type.
 *
 * @param o
 * Object.
 *
 * @param key
 * Key of property to cast.
 *
 * @returns
 * Single-key object with property cast as desired type.
 */
export function propertyAs<TAsType extends T[K], T extends object, K extends keyof T>(o: T, key: K): Readonly<Omit<T, K> extends T ? Partial<Record<K, TAsType>> : Record<K, TAsType>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Type is determined by condition.
    return (key in o ?
        {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Force cast.
            [key]: o[key] as TAsType
        } :
        {}
    ) as ReturnType<typeof propertyAs<TAsType, T, K>>;
}
