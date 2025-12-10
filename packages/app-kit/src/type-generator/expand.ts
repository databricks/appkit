import ts from "typescript";

/**
 * Expand type to a string to be used in the type declaration
 * @param type - the type to expand
 * @param typeChecker - the type checker
 * @param seen - the set of seen types
 * @param indent - the indent level
 * @returns the expanded type as a string
 */
export function expandType(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
  indent = 0,
): string {
  if (seen.has(type)) return typeChecker.typeToString(type);

  if (type.isUnion())
    return type.types.map((t) => expandType(t, typeChecker, seen)).join(" | ");

  if (type.isIntersection())
    return type.types.map((t) => expandType(t, typeChecker, seen)).join(" & ");

  if (typeChecker.isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs?.length) {
      const elementType = expandType(typeArgs[0], typeChecker, seen);
      return `${elementType}[]`;
    }
  }

  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;

    const typeName = typeChecker.typeToString(type);
    const builtInTypes = [
      "Date",
      "Map",
      "Set",
      "Promise",
      "RegExp",
      "Error",
      "URL",
      "Buffer",
    ];
    if (builtInTypes.some((t) => typeName.startsWith(t))) {
      return typeName;
    }

    const isNamedType =
      type.aliasSymbol ||
      objectType.objectFlags & ts.ObjectFlags.Reference ||
      objectType.objectFlags & ts.ObjectFlags.Interface;

    if (isNamedType) {
      const properties = type.getProperties();

      if (properties.length > 0) {
        seen.add(type);
        const spaces = " ".repeat(indent + 1);
        const closingSpaces = " ".repeat(indent);

        const props = properties.map((prop) => {
          const propType = typeChecker.getTypeOfSymbol(prop);
          const propTypeStr = expandType(
            propType,
            typeChecker,
            seen,
            indent + 1,
          );
          const isOptional = prop.flags & ts.SymbolFlags.Optional;
          return `${spaces}${prop.name}${isOptional ? "?" : ""}: ${propTypeStr}`;
        });

        return `{\n${props.join("\n")}\n${closingSpaces}}`;
      }
    }
  }

  // fallback
  return typeChecker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation,
  );
}
