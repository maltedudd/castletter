// Kanban #48: user-defined source categories – names, order and moving.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CATEGORY_NAME_LENGTH,
  categoryOf,
  moveCategory,
  normalizeCategoryName,
  sortCategories,
  validateCategoryName,
} from '../../src/lib/sources/categories.mjs'

const cat = (id, name, position) => ({ id, name, position })
const CATEGORIES = [cat('c', 'Politik', 2), cat('a', 'Technik', 0), cat('b', 'Kultur', 1)]
const ids = (list) => list.map((c) => c.id)

test('names are trimmed and inner whitespace collapsed', () => {
  assert.equal(normalizeCategoryName('  Wirtschaft \n und\tFinanzen  '), 'Wirtschaft und Finanzen')
  assert.equal(normalizeCategoryName(undefined), '')
})

test('a name must be non-empty, at most 50 characters and unique per user (case-insensitive)', () => {
  assert.equal(MAX_CATEGORY_NAME_LENGTH, 50)
  assert.equal(validateCategoryName('   ', CATEGORIES), 'empty')
  assert.equal(validateCategoryName('x'.repeat(51), CATEGORIES), 'tooLong')
  assert.equal(validateCategoryName('ä'.repeat(50), CATEGORIES), null, 'counted in characters, not bytes')
  assert.equal(validateCategoryName('😀'.repeat(50), CATEGORIES), null, 'counted in code points like char_length')
  assert.equal(validateCategoryName(' politik ', CATEGORIES), 'duplicate')
  assert.equal(validateCategoryName('Sport', CATEGORIES), null)
})

test('renaming a category to its own name (other casing) is allowed', () => {
  assert.equal(validateCategoryName('POLITIK', CATEGORIES, 'c'), null)
  assert.equal(validateCategoryName('Kultur', CATEGORIES, 'c'), 'duplicate')
})

test('categories are sorted by their position, ties by id; the input is not mutated', () => {
  const before = ids(CATEGORIES)
  assert.deepEqual(ids(sortCategories(CATEGORIES)), ['a', 'b', 'c'])
  assert.deepEqual(ids(sortCategories([cat('y', 'Y', 1), cat('x', 'X', 1), cat('z', 'Z', 0)])), ['z', 'x', 'y'])
  assert.deepEqual(ids(CATEGORIES), before)
  assert.deepEqual(sortCategories(undefined), [])
})

test('moving up/down swaps with the neighbour and returns the new id order', () => {
  assert.deepEqual(moveCategory(CATEGORIES, 'b', 'up'), ['b', 'a', 'c'])
  assert.deepEqual(moveCategory(CATEGORIES, 'b', 'down'), ['a', 'c', 'b'])
  // Positions with gaps (after a deletion) still move by one place.
  assert.deepEqual(moveCategory([cat('a', 'A', 0), cat('b', 'B', 5), cat('c', 'C', 9)], 'c', 'up'), ['a', 'c', 'b'])
})

test('moving beyond the edges or an unknown category changes nothing', () => {
  assert.equal(moveCategory(CATEGORIES, 'a', 'up'), null)
  assert.equal(moveCategory(CATEGORIES, 'c', 'down'), null)
  assert.equal(moveCategory(CATEGORIES, 'nope', 'up'), null)
  assert.equal(moveCategory(CATEGORIES, 'b', 'sideways'), null)
})

test('categoryOf: the category of a source, null when none, deleted or not the user\'s', () => {
  const byId = new Map(CATEGORIES.map((c) => [c.id, c]))
  assert.deepEqual(categoryOf({ category_id: 'b' }, byId), { id: 'b', name: 'Kultur', position: 1 })
  assert.equal(categoryOf({ category_id: null }, byId), null)
  assert.equal(categoryOf({}, byId), null)
  assert.equal(categoryOf({ category_id: 'deleted' }, byId), null)
  assert.equal(categoryOf(undefined, byId), null)
})
