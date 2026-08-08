const DEFAULT_USERS_COLLECTION = 'astratra_users';
const DEFAULT_SETTINGS_COLLECTION = 'astratra_settings';

function loadMongoose() {
  try {
    return require('mongoose');
  } catch (_error) {
    throw new Error('@astratra/store-mongo requires mongoose. Install mongoose or pass it from an app that already depends on it.');
  }
}

function modelName(prefix, collection) {
  const safeCollection = String(collection).replace(/[^a-zA-Z0-9_]/g, '_');
  return `Astratra${prefix}_${safeCollection}`;
}

function createConnectionContext(options = {}) {
  const mongoose = loadMongoose();
  if (options.connection) {
    return {
      mongoose,
      connection: options.connection,
      managed: false,
      ready: Promise.resolve()
    };
  }

  if (!options.uri) {
    throw new Error('createMongo store requires options.connection or options.uri.');
  }

  const connection = mongoose.createConnection(options.uri, options.connectionOptions || {});
  return {
    mongoose,
    connection,
    managed: true,
    ready: typeof connection.asPromise === 'function' ? connection.asPromise() : Promise.resolve(connection)
  };
}

function getModel(connection, name, schema, collection) {
  if (connection.models[name]) {
    return connection.models[name];
  }
  return connection.model(name, schema, collection);
}

function stripMongoFields(doc) {
  if (!doc) return null;
  const plain = { ...doc };
  if (plain.id === undefined && plain._id !== undefined) {
    plain.id = String(plain._id);
  }
  delete plain._id;
  delete plain.__v;
  return plain;
}

function isDuplicateKeyError(error) {
  return error && (error.code === 11000 || error.code === 11001);
}

function nullForCastError(error) {
  if (error && (error.name === 'CastError' || error.name === 'BSONError')) {
    return null;
  }
  throw error;
}

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(number, 0) : fallback;
}

function initModel(Model) {
  if (!Model.astratraInitPromise) {
    Model.astratraInitPromise = Model.init();
  }
  return Model.astratraInitPromise;
}

function createMongoUsersStore(options = {}) {
  const collection = options.collection || DEFAULT_USERS_COLLECTION;
  const uniqueEmail = options.uniqueEmail !== false;
  const context = createConnectionContext(options);
  const schema = new context.mongoose.Schema({
    email: { type: String, index: uniqueEmail ? { unique: true } : true },
    role: String
  }, {
    strict: false
  });
  const User = getModel(context.connection, modelName('User', collection), schema, collection);

  async function ready() {
    await context.ready;
    if (uniqueEmail) {
      await initModel(User);
    }
  }

  return {
    async findByEmail(email) {
      await ready();
      const user = await User.findOne({ email }).lean();
      return stripMongoFields(user);
    },

    async findById(id) {
      await ready();
      try {
        const user = await User.findById(id).lean();
        return stripMongoFields(user);
      } catch (error) {
        return nullForCastError(error);
      }
    },

    async create(userData) {
      await ready();
      const data = { ...(userData || {}) };
      if (data.id !== undefined && data._id === undefined && context.mongoose.isValidObjectId(data.id)) {
        data._id = data.id;
        delete data.id;
      }

      try {
        const user = await User.create(data);
        return stripMongoFields(user.toObject());
      } catch (error) {
        if (uniqueEmail && isDuplicateKeyError(error)) {
          throw error;
        }
        throw error;
      }
    },

    async list({ role, limit = 50, offset = 0 } = {}) {
      await ready();
      const query = role ? { role } : {};
      const users = await User.find(query)
        .sort({ _id: 1 })
        .skip(safeNumber(offset, 0))
        .limit(safeNumber(limit, 50))
        .lean();
      return users.map(stripMongoFields);
    },

    async update(id, patch) {
      await ready();
      const data = { ...(patch || {}) };
      delete data.id;
      delete data._id;

      try {
        const user = await User.findByIdAndUpdate(id, { $set: data }, {
          new: true,
          runValidators: false
        }).lean();
        return stripMongoFields(user);
      } catch (error) {
        return nullForCastError(error);
      }
    },

    async disconnect() {
      if (context.managed) {
        await context.connection.close();
      }
    }
  };
}

function createMongoSettingsStore(options = {}) {
  const collection = options.collection || DEFAULT_SETTINGS_COLLECTION;
  const context = createConnectionContext(options);
  const schema = new context.mongoose.Schema({
    key: { type: String, unique: true, index: true },
    value: context.mongoose.Schema.Types.Mixed
  }, {
    strict: false
  });
  const Setting = getModel(context.connection, modelName('Setting', collection), schema, collection);

  async function ready() {
    await context.ready;
    await initModel(Setting);
  }

  return {
    async get(key) {
      await ready();
      const setting = await Setting.findOne({ key }).lean();
      return setting ? setting.value : null;
    },

    async set(key, value) {
      await ready();
      await Setting.findOneAndUpdate(
        { key },
        { $set: { key, value } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    },

    async getAll() {
      await ready();
      const settings = await Setting.find({}).lean();
      return Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
    },

    async disconnect() {
      if (context.managed) {
        await context.connection.close();
      }
    }
  };
}

module.exports = {
  createMongoSettingsStore,
  createMongoUsersStore
};
