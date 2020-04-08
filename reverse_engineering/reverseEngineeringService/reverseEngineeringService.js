const {
	getTableInfo,
	getTableRow,
	getTableForeignKeys,
	getDatabaseIndexes,
	getTableColumnsDescription,
	getDatabaseMemoryOptimizedTables,
	getDatabaseCheckConstraints,
	getViewTableInfo,
	getTableKeyConstraints,
	getViewColumnRelations,
	getTableMaskedColumns,
	getDatabaseXmlSchemaCollection,
	getTableDefaultConstraintNames,
	getDatabaseUserDefinedTypes,
	getViewStatement,
} = require('../databaseService/databaseService');
const {
	transformDatabaseTableInfoToJSON,
	reverseTableForeignKeys,
	reverseTableIndexes,
	defineRequiredFields,
	defineFieldsDescription,
	doesViewHaveRelatedTables,
	reverseTableCheckConstraints,
	changeViewPropertiesToReferences,
	defineFieldsKeyConstraints,
	defineMaskedColumns,
	defineJSONTypes,
	defineXmlFieldsCollections,
	defineFieldsDefaultConstraintNames,
	defineFieldsCompositeKeyConstraints,
	getUserDefinedTypes,
	reorderTableRows,
} = require('./helpers');
const pipe = require('../helpers/pipe');

const mergeCollectionsWithViews = jsonSchemas =>
	jsonSchemas.reduce((structuredJSONSchemas, jsonSchema) => {
		if (jsonSchema.relatedTables) {
			const currentIndex = structuredJSONSchemas.findIndex(structuredSchema =>
				jsonSchema.collectionName === structuredSchema.collectionName && jsonSchema.dbName);
			const relatedTableSchemaIndex = structuredJSONSchemas.findIndex(({ collectionName, dbName }) =>
				jsonSchema.relatedTables.find(({ tableName, schemaName }) => tableName === collectionName && schemaName === dbName));

			if (relatedTableSchemaIndex !== -1 && doesViewHaveRelatedTables(jsonSchema, structuredJSONSchemas)) {
				structuredJSONSchemas[relatedTableSchemaIndex].views.push(jsonSchema);
			}

			delete jsonSchema.relatedTables;
			return structuredJSONSchemas.filter((schema, i) => i !== currentIndex);
		}

		return structuredJSONSchemas;
	}, jsonSchemas);

const getCollectionsRelationships = logger => async (dbConnectionClient) => {
	const dbName = dbConnectionClient.config.database;
	logger.progress({ message: 'Fetching tables relationships', containerName: dbName, entityName: '' });
	const tableForeignKeys = await getTableForeignKeys(dbConnectionClient, dbName);
	return reverseTableForeignKeys(tableForeignKeys, dbName);
};

const getStandardDocumentByJsonSchema = (jsonSchema) => {
	return Object.keys(jsonSchema.properties).reduce((result, key) => {
		return {
			...result,
			[key]: ""
		};
	}, {});
};

const isViewPartitioned = (viewStatement) => {
	viewStatement = String(viewStatement).trim();
	const viewContentRegexp = /CREATE[\s\S]+?VIEW[\s\S]+AS([\s\S]+)/i;

	if (!viewContentRegexp.test(viewStatement)) {
		return false;
	}

	const content = viewStatement.match(viewContentRegexp)[1] || '';
	const hasUnionAll = content.toLowerCase().split(/union[\s\S]+?all/i).length;

	return Boolean(hasUnionAll);
};

const getPartitionedJsonSchema = (viewInfo, viewColumnRelations) => {
	const aliasToName = viewInfo.reduce((aliasToName, item) => ({
		...aliasToName,
		[item.ColumnName]: item.ReferencedColumnName
	}), {});
	const tableName = viewInfo[0]['ReferencedTableName'];

	const properties = viewColumnRelations.reduce((properties, column) => ({
		...properties,
		[column.name]: {
			$ref: `#collection/definitions/${tableName}/${aliasToName[column.name]}`,
			bucketName: column['source_schema'] || '',
		}
	}), {});

	return {
		properties
	};
};

const getPartitionedTables = (viewInfo) => {
	const hasTable = (tables, item) => tables.some(
		table => table.table[0] === item.ReferencedSchemaName && table.table[1] === item.ReferencedTableName
	);
	
	return viewInfo.reduce((tables, item) => {
		if (!hasTable(tables, item)) {
			return tables.concat([{
				table: [ item.ReferencedSchemaName, item.ReferencedTableName ]
			}]);
		} else {
			return tables;
		}
	}, []);
};

const prepareViewJSON = (dbConnectionClient, dbName, viewName, schemaName) => async jsonSchema => {
	const [viewInfo, viewColumnRelations, viewStatement] = await Promise.all([
		await getViewTableInfo(dbConnectionClient, dbName, viewName, schemaName),
		await getViewColumnRelations(dbConnectionClient, dbName, viewName, schemaName),
		await getViewStatement(dbConnectionClient, dbName, viewName, schemaName),
	]);
	if (isViewPartitioned(viewStatement[0].definition)) {
		const partitionedSchema = getPartitionedJsonSchema(
			viewInfo,
			viewColumnRelations
		);

		return {
			jsonSchema: JSON.stringify({
				...jsonSchema,
				properties: {
					...(jsonSchema.properties || {}),
					...partitionedSchema.properties,
				}
			}),
			data: {
				partitioned: true,
				partitionedTables: getPartitionedTables(viewInfo),
			},
			name: viewName,
			relatedTables: [{
				tableName: viewInfo[0]['ReferencedTableName'],
				schemaName: viewInfo[0]['ReferencedSchemaName'],
			}],
		};
	} else {
		return {
			jsonSchema: JSON.stringify(changeViewPropertiesToReferences(jsonSchema, viewInfo, viewColumnRelations)),
			name: viewName,
			relatedTables: viewInfo.map((columnInfo => ({
				tableName: columnInfo['ReferencedTableName'],
				schemaName: columnInfo['ReferencedSchemaName'],
			}))),
		};
	}
};

const cleanNull = doc => Object.entries(doc).filter(([ key, value ]) => value !== null).reduce((result, [key, value]) => ({
	...result,
	[key]: value,
}), {});

const cleanDocuments = (documents) => {
	if (!Array.isArray(documents)) {
		return documents;
	}

	return documents.map(cleanNull);
}

const reverseCollectionsToJSON = logger => async (dbConnectionClient, tablesInfo, reverseEngineeringOptions) => {
	const dbName = dbConnectionClient.config.database;
	const [
		databaseIndexes, databaseMemoryOptimizedTables, databaseCheckConstraints, xmlSchemaCollections, databaseUDT
	] = await Promise.all([
		await getDatabaseIndexes(dbConnectionClient, dbName),
		await getDatabaseMemoryOptimizedTables(dbConnectionClient, dbName),
		await getDatabaseCheckConstraints(dbConnectionClient, dbName),
		await getDatabaseXmlSchemaCollection(dbConnectionClient, dbName),
		await getDatabaseUserDefinedTypes(dbConnectionClient, dbName),
	]);
	return await Object.entries(tablesInfo).reduce(async (jsonSchemas, [schemaName, tableNames]) => {
		logger.progress({ message: 'Fetching database information', containerName: dbName, entityName: '' });
		const tablesInfo = await Promise.all(
			tableNames.map(async untrimmedTableName => {
				const tableName = untrimmedTableName.replace(/ \(v\)$/, '');
				const tableIndexes = databaseIndexes.filter(index =>
					index.TableName === tableName && index.schemaName === schemaName);
				const tableXmlSchemas = xmlSchemaCollections.filter(collection =>
					collection.tableName === tableName && collection.schemaName === schemaName);
				const tableCheckConstraints = databaseCheckConstraints.filter(cc => cc.table === tableName);
				logger.progress({ message: 'Fetching table information', containerName: dbName, entityName: tableName });

				const [tableInfo, tableRows, fieldsKeyConstraints] = await Promise.all([
					await getTableInfo(dbConnectionClient, dbName, tableName, schemaName),
					await getTableRow(dbConnectionClient, dbName, tableName, schemaName, reverseEngineeringOptions.rowCollectionSettings),
					await getTableKeyConstraints(dbConnectionClient, dbName, tableName, schemaName)
				]);
				const isView = tableInfo[0]['TABLE_TYPE'].trim() === 'V';

				const jsonSchema = pipe(
					transformDatabaseTableInfoToJSON(tableInfo),
					defineRequiredFields,
					defineFieldsDescription(await getTableColumnsDescription(dbConnectionClient, dbName, tableName, schemaName)),
					defineFieldsKeyConstraints(fieldsKeyConstraints),
					defineMaskedColumns(await getTableMaskedColumns(dbConnectionClient, dbName, tableName, schemaName)),
					defineJSONTypes(tableRows),
					defineXmlFieldsCollections(tableXmlSchemas),
					defineFieldsDefaultConstraintNames(await getTableDefaultConstraintNames(dbConnectionClient, dbName, tableName, schemaName)),
				)({ required: [], properties: {} });

				const reorderedTableRows = reorderTableRows(tableRows, reverseEngineeringOptions.isFieldOrderAlphabetic);
				const standardDoc = Array.isArray(reorderedTableRows) && reorderedTableRows.length
					? reorderedTableRows
					: reorderTableRows([getStandardDocumentByJsonSchema(jsonSchema)], reverseEngineeringOptions.isFieldOrderAlphabetic);

				return {
					collectionName: tableName,
					dbName: schemaName,
					entityLevel: {
						Indxs: reverseTableIndexes(tableIndexes),
						memory_optimized: databaseMemoryOptimizedTables.includes(tableName),
						chkConstr: reverseTableCheckConstraints(tableCheckConstraints),
						...defineFieldsCompositeKeyConstraints(fieldsKeyConstraints),
					},
					standardDoc: standardDoc,
					documentTemplate: standardDoc,
					collectionDocs: reorderedTableRows,
					documents: cleanDocuments(reorderedTableRows),
					bucketInfo: {
						databaseName: dbName,
					},
					modelDefinitions: {
						definitions: getUserDefinedTypes(tableInfo, databaseUDT),
					},
					emptyBucket: false,
					...(isView
						? await prepareViewJSON(dbConnectionClient, dbName, tableName, schemaName)(jsonSchema)
						: {
							validation: { jsonSchema },
							views: [],
						}
					)
				};
			})
		);
		return [...await jsonSchemas, ...tablesInfo.filter(Boolean)];
	}, Promise.resolve([]));
};

module.exports = {
	reverseCollectionsToJSON,
	mergeCollectionsWithViews,
	getCollectionsRelationships,
};
