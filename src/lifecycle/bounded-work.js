async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
  const values = Array.from(items || []);
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array(values.length);
  let nextIndex = 0;
  let failure;

  const worker = async () => {
    while (!failure && !options.cancelled?.()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) {
        return;
      }
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        failure ||= error;
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker()
  ));
  if (failure) {
    throw failure;
  }
  return results;
}

module.exports = { mapWithConcurrency };
